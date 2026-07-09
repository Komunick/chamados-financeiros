'use strict';
/*
 * Chamados Financeiros — servidor HTTP (base compartilhada).
 * ---------------------------------------------------------------------------
 * Node puro, SEM dependências externas (não precisa de npm install).
 *  - Serve os arquivos estáticos do app (index.html, app.js, styles.css).
 *  - API /api/* : autenticação, chamados, anexos (fotos), notificações, usuários.
 *  - SSE em /api/events para atualização em tempo real dos navegadores.
 *  - Verificador periódico: 5 dias após a confirmação de encerramento da
 *    viagem, gera a notificação de lembrete do pagamento do saldo.
 *
 * Papéis: solicitante (abre chamados), financeiro (recebe notificações e
 * registra pagamentos), admin (tudo + usuários).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const d = require('./db');

const PORT = parseInt(process.env.PORT, 10) || 8090;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.join(__dirname, '..'); // pasta chamados-web (arquivos do app)

// 5 dias por padrão; CHAMADOS_LEMBRETE_MS permite encurtar em testes.
const LEMBRETE_MS = parseInt(process.env.CHAMADOS_LEMBRETE_MS, 10) || 5 * 24 * 60 * 60 * 1000;
const BODY_LIMIT = parseInt(process.env.CHAMADOS_BODY_LIMIT, 10) || 25 * 1024 * 1024; // 25 MB (fotos em base64)
const ANEXO_MAX = 12 * 1024 * 1024; // 12 MB por imagem (binário)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const IMAGENS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

function send(res, status, body, headers) {
  res.writeHead(status, headers || {});
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}
function erro(res, status, msg) { sendJson(res, status, { error: msg }); }

// ---------------------------------------------------------------------------
// Tempo real (Server-Sent Events).
// ---------------------------------------------------------------------------
const sseClients = new Set();
let revision = 0;

function handleSSE(req, res, query) {
  const usuario = d.usuarioPorToken(query.get('token'));
  if (!usuario) return erro(res, 401, 'Sessão inválida.');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(': conectado\n\n');
  sseClients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }, 25000);
  const done = () => { clearInterval(ping); sseClients.delete(res); };
  req.on('close', done);
  req.on('error', done);
}

function broadcast(evt) {
  const payload = 'data: ' + JSON.stringify(evt) + '\n\n';
  for (const res of sseClients) {
    try { res.write(payload); } catch (e) { sseClients.delete(res); }
  }
}

function notifyChange(recurso) {
  revision += 1;
  broadcast({ tipo: 'mudanca', rev: revision, recurso });
}

// ---------------------------------------------------------------------------
// Utilidades de validação.
// ---------------------------------------------------------------------------
function txt(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max || 200);
}
function centavos(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0 || n > 100000000000) return null; // até R$ 1 bilhão
  return n;
}
function reaisFmt(cent) {
  return (cent / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function dataFmt(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  return dt.toLocaleDateString('pt-BR') + ' ' + dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// Padronização de dados brasileiros (placa, telefone, CPF, CNH).
// Retornam o valor normalizado, '' quando vazio (campo opcional) ou null
// quando o valor informado é inválido.
// ---------------------------------------------------------------------------
function normPlaca(v) {
  const p = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!p) return '';
  if (/^[A-Z]{3}[0-9]{4}$/.test(p)) return p.slice(0, 3) + '-' + p.slice(3); // modelo antigo ABC-1234
  if (/^[A-Z]{3}[0-9][A-Z][0-9]{2}$/.test(p)) return p;                      // Mercosul ABC1D23
  return null;
}
function normTelefone(v) {
  const t = String(v || '').replace(/\D/g, '');
  if (!t) return '';
  if (t.length === 11) return '(' + t.slice(0, 2) + ') ' + t.slice(2, 7) + '-' + t.slice(7);
  if (t.length === 10) return '(' + t.slice(0, 2) + ') ' + t.slice(2, 6) + '-' + t.slice(6);
  return null;
}
function normCpf(v) {
  const c = String(v || '').replace(/\D/g, '');
  if (!c) return '';
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return null;
  const dv = (base) => {
    let s = 0;
    for (let i = 0; i < base.length; i++) s += Number(base[i]) * (base.length + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  if (dv(c.slice(0, 9)) !== Number(c[9]) || dv(c.slice(0, 10)) !== Number(c[10])) return null;
  return c.slice(0, 3) + '.' + c.slice(3, 6) + '.' + c.slice(6, 9) + '-' + c.slice(9);
}
function normCnh(v) {
  const c = String(v || '').replace(/\D/g, '');
  if (!c) return '';
  if (c.length !== 11) return null;
  return c;
}
function normDataViagem(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00'))) return null;
  return s;
}
function dataViagemFmt(s) {
  if (!s) return '';
  const [a, m, d] = s.split('-');
  return d + '/' + m + '/' + a;
}

function publicoUsuario(u) {
  return { id: u.id, nome: u.nome, login: u.login, papel: u.papel, criadoEm: u.criadoEm };
}

function acharChamado(id) {
  return d.db.chamados.find((c) => c.id === id) || null;
}

function historico(chamado, usuario, acao, detalhe) {
  chamado.historico.push({ em: d.agora(), por: usuario ? usuario.nome : 'sistema', acao, detalhe: detalhe || null });
}

// ---------------------------------------------------------------------------
// Auditoria: trilha de todos os acessos e alterações (quem, o quê, quando,
// de onde). Visível apenas para financeiro/admin. Não grava sozinha — cada
// ponto de chamada já faz d.flush() logo em seguida.
// ---------------------------------------------------------------------------
function auditar(usuario, acao, detalhe, ip) {
  d.db.auditoria.push({
    id: d.novoIdAuditoria(),
    em: d.agora(),
    usuario: usuario
      ? { id: usuario.id, nome: usuario.nome, login: usuario.login, papel: usuario.papel }
      : null, // null = sistema ou acesso não autenticado (ver "acao")
    acao,
    detalhe: detalhe || null,
    ip: ip || null,
  });
  // Mantém a trilha com tamanho limitado.
  if (d.db.auditoria.length > 5000) d.db.auditoria = d.db.auditoria.slice(-4000);
}

// ---------------------------------------------------------------------------
// Notificações (para o financeiro / notificador de bandeja).
// ---------------------------------------------------------------------------
function criarNotificacao(tipo, chamado, titulo, mensagem) {
  const n = {
    id: d.novoIdNotificacao(),
    em: d.agora(),
    tipo, // 'novo_chamado' | 'viagem_encerrada' | 'lembrete_saldo'
    chamadoId: chamado.id,
    titulo,
    mensagem,
    dados: chamado.tipo === 'compra' ? {
      chamadoId: chamado.id,
      tipoChamado: 'compra',
      solicitante: chamado.solicitante.nome,
      descricao: chamado.compra ? chamado.compra.descricao : '',
      fornecedor: chamado.compra ? chamado.compra.fornecedor : '',
      valorTotal: reaisFmt(chamado.valorTotalCent),
      status: chamado.status,
    } : {
      chamadoId: chamado.id,
      tipoChamado: 'viagem',
      solicitante: chamado.solicitante.nome,
      veiculo: (chamado.veiculo.placa + ' — ' + chamado.veiculo.modelo).trim(),
      condutor: chamado.condutor.nome,
      rota: chamado.rota || '',
      dataViagem: dataViagemFmt(chamado.dataViagem),
      valorTotal: reaisFmt(chamado.valorTotalCent),
      adiantamento: reaisFmt(chamado.adiantamentoCent),
      saldo: reaisFmt(chamado.saldoCent),
      status: chamado.status,
    },
    reconhecidaPor: null,
  };
  d.db.notificacoes.push(n);
  // Mantém no máximo 500 notificações no histórico.
  if (d.db.notificacoes.length > 500) d.db.notificacoes = d.db.notificacoes.slice(-400);
  broadcast({ tipo: 'notificacao', notificacao: n });
  return n;
}

function reconhecerNotificacoesDoChamado(chamadoId, usuario, tipos) {
  for (const n of d.db.notificacoes) {
    if (n.chamadoId === chamadoId && !n.reconhecidaPor && (!tipos || tipos.includes(n.tipo))) {
      n.reconhecidaPor = { id: usuario ? usuario.id : 'sistema', nome: usuario ? usuario.nome : 'sistema', em: d.agora() };
    }
  }
}

// Lembrete do saldo: 5 dias após a confirmação de encerramento da viagem.
function verificarLembretes() {
  let mudou = false;
  const t = Date.now();
  for (const c of d.db.chamados) {
    if (c.status === 'cancelado' || c.tipo === 'compra') continue;
    if (!c.encerramentoConfirmadoEm || c.saldoPagoEm || c.lembreteSaldoEm) continue;
    if (t - Date.parse(c.encerramentoConfirmadoEm) < LEMBRETE_MS) continue;
    c.lembreteSaldoEm = d.agora();
    criarNotificacao(
      'lembrete_saldo', c,
      'Lembrete: pagar saldo do chamado ' + c.id,
      'A viagem foi encerrada em ' + dataFmt(c.encerramentoConfirmadoEm) + ' (há 5 dias). ' +
        'Saldo a pagar: ' + reaisFmt(c.saldoCent) + '. Solicitante: ' + c.solicitante.nome +
        '. Veículo: ' + c.veiculo.placa + '. Condutor: ' + c.condutor.nome + '.'
    );
    historico(c, null, 'Lembrete de pagamento do saldo gerado (5 dias após o encerramento).');
    auditar(null, 'Lembrete de saldo gerado (automático)', c.id + ' · ' + reaisFmt(c.saldoCent), null);
    mudou = true;
  }
  if (mudou) { d.flush(); notifyChange('notificacoes'); }
}

// ---------------------------------------------------------------------------
// Proteção simples contra força bruta no login (por IP).
// ---------------------------------------------------------------------------
const tentativas = new Map(); // ip -> { falhas, bloqueadoAte }
function loginBloqueado(ip) {
  const t = tentativas.get(ip);
  return !!(t && t.bloqueadoAte && t.bloqueadoAte > Date.now());
}
function registrarFalhaLogin(ip) {
  const t = tentativas.get(ip) || { falhas: 0, bloqueadoAte: 0 };
  t.falhas += 1;
  t.visto = Date.now();
  if (t.falhas >= 5) { t.bloqueadoAte = Date.now() + 60 * 1000; t.falhas = 0; }
  tentativas.set(ip, t);
  if (tentativas.size > 500) pruneTentativas();
}
function limparFalhasLogin(ip) { tentativas.delete(ip); }
// Evita o mapa crescer sem limite: descarta IPs inativos há mais de 1h e sem
// bloqueio ativo.
function pruneTentativas() {
  const limite = Date.now() - 60 * 60 * 1000;
  for (const [ip, t] of tentativas) {
    if ((t.visto || 0) < limite && (!t.bloqueadoAte || t.bloqueadoAte < Date.now())) tentativas.delete(ip);
  }
}

// ---------------------------------------------------------------------------
// Rotas da API.
// ---------------------------------------------------------------------------
// handler(ctx) — ctx = { req, res, usuario, body, params, query, ip }
// papeis: null = qualquer usuário autenticado; [] com 'anon' = sem login.
const rotas = [];
function rota(metodo, padrao, papeis, handler) {
  const keys = [];
  const re = new RegExp('^' + padrao.replace(/:[a-zA-Z]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  rotas.push({ metodo, re, keys, papeis, handler });
}

// ---- autenticação ----------------------------------------------------------
rota('POST', '/api/auth/login', ['anon'], (ctx) => {
  if (loginBloqueado(ctx.ip)) return erro(ctx.res, 429, 'Muitas tentativas. Aguarde 1 minuto.');
  const login = txt(ctx.body.login, 60).toLowerCase();
  const senha = String(ctx.body.senha || '');
  const u = d.db.usuarios.find((x) => x.login === login);
  if (!u || d.hashSenha(senha, u.sal) !== u.senhaHash) {
    registrarFalhaLogin(ctx.ip);
    auditar(null, 'Tentativa de login recusada', 'Login informado: ' + (login || '(vazio)'), ctx.ip);
    d.flush();
    return erro(ctx.res, 401, 'Login ou senha inválidos.');
  }
  limparFalhasLogin(ctx.ip);
  auditar(u, 'Entrou no sistema (login)', null, ctx.ip);
  const token = d.criarSessao(u); // criarSessao grava no disco (inclui a auditoria)
  sendJson(ctx.res, 200, { token, usuario: publicoUsuario(u) });
});

rota('POST', '/api/auth/logout', null, (ctx) => {
  auditar(ctx.usuario, 'Saiu do sistema (logout)', null, ctx.ip);
  d.encerrarSessao(ctx.token); // grava no disco
  sendJson(ctx.res, 200, { ok: true });
});

rota('GET', '/api/me', null, (ctx) => {
  sendJson(ctx.res, 200, { usuario: publicoUsuario(ctx.usuario) });
});

rota('POST', '/api/auth/trocar-senha', null, (ctx) => {
  const atual = String(ctx.body.senhaAtual || '');
  const nova = String(ctx.body.novaSenha || '');
  if (d.hashSenha(atual, ctx.usuario.sal) !== ctx.usuario.senhaHash) return erro(ctx.res, 400, 'Senha atual incorreta.');
  if (nova.length < 6) return erro(ctx.res, 400, 'A nova senha precisa ter ao menos 6 caracteres.');
  ctx.usuario.sal = d.novoSal();
  ctx.usuario.senhaHash = d.hashSenha(nova, ctx.usuario.sal);
  auditar(ctx.usuario, 'Trocou a própria senha', null, ctx.ip);
  d.flush();
  sendJson(ctx.res, 200, { ok: true });
});

// ---- usuários (admin) ------------------------------------------------------
rota('GET', '/api/usuarios', ['admin'], (ctx) => {
  sendJson(ctx.res, 200, { usuarios: d.db.usuarios.map(publicoUsuario) });
});

rota('POST', '/api/usuarios', ['admin'], (ctx) => {
  const nome = txt(ctx.body.nome, 80);
  const login = txt(ctx.body.login, 60).toLowerCase();
  const senha = String(ctx.body.senha || '');
  const papel = String(ctx.body.papel || '');
  if (!nome || !login) return erro(ctx.res, 400, 'Informe nome e login.');
  if (!/^[a-z0-9._-]+$/.test(login)) return erro(ctx.res, 400, 'Login: use apenas letras, números, ponto, hífen.');
  if (senha.length < 6) return erro(ctx.res, 400, 'A senha precisa ter ao menos 6 caracteres.');
  if (!['solicitante', 'financeiro', 'admin'].includes(papel)) return erro(ctx.res, 400, 'Papel inválido.');
  if (d.db.usuarios.some((u) => u.login === login)) return erro(ctx.res, 409, 'Já existe um usuário com esse login.');
  const u = d.criarUsuarioObj(nome, login, senha, papel);
  d.db.usuarios.push(u);
  auditar(ctx.usuario, 'Criou usuário', nome + ' (' + login + ', papel ' + papel + ')', ctx.ip);
  d.flush();
  notifyChange('usuarios');
  sendJson(ctx.res, 200, { usuario: publicoUsuario(u) });
});

rota('PUT', '/api/usuarios/:id', ['admin'], (ctx) => {
  const u = d.db.usuarios.find((x) => x.id === ctx.params.id);
  if (!u) return erro(ctx.res, 404, 'Usuário não encontrado.');
  const mudancas = [];
  if (ctx.body.nome !== undefined) {
    u.nome = txt(ctx.body.nome, 80) || u.nome;
    mudancas.push('nome');
  }
  if (ctx.body.papel !== undefined) {
    if (!['solicitante', 'financeiro', 'admin'].includes(ctx.body.papel)) return erro(ctx.res, 400, 'Papel inválido.');
    if (u.papel === 'admin' && ctx.body.papel !== 'admin' &&
        d.db.usuarios.filter((x) => x.papel === 'admin').length <= 1) {
      return erro(ctx.res, 400, 'Não é possível rebaixar o único admin.');
    }
    u.papel = ctx.body.papel;
    mudancas.push('papel → ' + u.papel);
  }
  if (ctx.body.novaSenha) {
    if (String(ctx.body.novaSenha).length < 6) return erro(ctx.res, 400, 'A senha precisa ter ao menos 6 caracteres.');
    u.sal = d.novoSal();
    u.senhaHash = d.hashSenha(String(ctx.body.novaSenha), u.sal);
    mudancas.push('senha');
  }
  auditar(ctx.usuario, 'Alterou usuário', u.nome + ' (' + u.login + '): ' + (mudancas.join(', ') || 'sem mudanças'), ctx.ip);
  d.flush();
  notifyChange('usuarios');
  sendJson(ctx.res, 200, { usuario: publicoUsuario(u) });
});

rota('DELETE', '/api/usuarios/:id', ['admin'], (ctx) => {
  const u = d.db.usuarios.find((x) => x.id === ctx.params.id);
  if (!u) return erro(ctx.res, 404, 'Usuário não encontrado.');
  if (u.id === ctx.usuario.id) return erro(ctx.res, 400, 'Você não pode remover a si mesmo.');
  if (u.papel === 'admin' && d.db.usuarios.filter((x) => x.papel === 'admin').length <= 1) {
    return erro(ctx.res, 400, 'Não é possível remover o único admin.');
  }
  d.db.usuarios = d.db.usuarios.filter((x) => x.id !== u.id);
  d.db.sessoes = d.db.sessoes.filter((s) => s.usuarioId !== u.id);
  auditar(ctx.usuario, 'Removeu usuário', u.nome + ' (' + u.login + ', papel ' + u.papel + ')', ctx.ip);
  d.flush();
  notifyChange('usuarios');
  sendJson(ctx.res, 200, { ok: true });
});

// ---- chamados ---------------------------------------------------------------
function podeVerChamado(usuario, chamado) {
  if (usuario.papel === 'admin' || usuario.papel === 'financeiro') return true;
  return chamado.solicitante.id === usuario.id;
}

rota('GET', '/api/chamados', null, (ctx) => {
  let lista = d.db.chamados;
  if (ctx.usuario.papel === 'solicitante') {
    lista = lista.filter((c) => c.solicitante.id === ctx.usuario.id);
  }
  // Mais recentes primeiro.
  lista = lista.slice().sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : -1));
  sendJson(ctx.res, 200, { chamados: lista });
});

rota('POST', '/api/chamados', null, (ctx) => {
  const tipo = ctx.body.tipo === 'compra' ? 'compra'
    : ctx.body.tipo === 'colaborador' ? 'colaborador'
    : 'viagem';
  // Valor é obrigatório só no transporte (o 70/30 depende dele). Compra e
  // viagem de colaborador podem abrir sem valor (definido depois, ao pagar
  // ou pelos comprovantes anexados).
  const valorTotalCent = centavos(ctx.body.valorTotalCent) || 0;
  if (tipo === 'viagem' && !valorTotalCent) {
    return erro(ctx.res, 400, 'Informe um valor total válido (maior que zero).');
  }

  const base = {
    id: d.novoIdChamado(),
    tipo,
    criadoEm: d.agora(),
    solicitante: { id: ctx.usuario.id, nome: ctx.usuario.nome },
    observacoes: txt(ctx.body.observacoes, 1000),
    valorTotalCent,
    status: 'aberto',
    anexos: { entrada: [], saida: [] },
    historico: [],
  };

  let chamado;
  if (tipo === 'compra') {
    // Chamado de COMPRA: pagamento único, sem 70/30.
    const compra = {
      descricao: txt(ctx.body.compra && ctx.body.compra.descricao, 200),
      fornecedor: txt(ctx.body.compra && ctx.body.compra.fornecedor, 120),
    };
    if (!compra.descricao) return erro(ctx.res, 400, 'Informe a descrição da compra.');
    const valorTxt = valorTotalCent ? reaisFmt(valorTotalCent) : 'a definir';
    chamado = Object.assign(base, {
      compra,
      veiculo: null,
      condutor: null,
      rota: '',
      dataViagem: null,
      adiantamentoCent: 0,
      saldoCent: 0,
      adiantamentoPagoEm: null,
      encerramentoConfirmadoEm: null,
      lembreteSaldoEm: null,
      saldoPagoEm: null,
      compraPagaEm: null,
      // aberto → finalizado (compra paga) | cancelado
    });
    historico(chamado, ctx.usuario, 'Chamado de compra aberto.',
      compra.descricao + ' · Valor ' + valorTxt);
    d.db.chamados.push(chamado);
    auditar(ctx.usuario, 'Abriu chamado de compra ' + chamado.id,
      compra.descricao + (compra.fornecedor ? ' · Fornecedor: ' + compra.fornecedor : '') +
      ' · Valor ' + valorTxt, ctx.ip);
    criarNotificacao(
      'novo_chamado', chamado,
      'Nova compra ' + chamado.id + ' — ' + ctx.usuario.nome,
      'Solicitante: ' + ctx.usuario.nome +
        '. Compra: ' + compra.descricao +
        (compra.fornecedor ? '. Fornecedor: ' + compra.fornecedor : '') +
        '. Valor: ' + valorTxt + '.'
    );
  } else if (tipo === 'colaborador') {
    // Chamado de VIAGEM DE COLABORADOR: pagamento único (reembolso), com
    // comprovantes por categoria (hotel, passagens, alimentação).
    const vc = ctx.body.colaborador || {};
    const dataIda = normDataViagem(vc.dataIda);
    if (!dataIda) return erro(ctx.res, 400, 'Informe a data de ida da viagem.');
    const dataVolta = normDataViagem(vc.dataVolta);
    if (dataVolta === null) return erro(ctx.res, 400, 'Data de volta inválida.');
    const colaborador = {
      nome: txt(vc.nome, 80),
      destino: txt(vc.destino, 160),
      dataIda,
      dataVolta: dataVolta || null,
      motivo: txt(vc.motivo, 300),
    };
    if (!colaborador.nome) return erro(ctx.res, 400, 'Informe o nome do colaborador.');
    if (!colaborador.destino) return erro(ctx.res, 400, 'Informe o destino da viagem.');
    const valorTxt = valorTotalCent ? reaisFmt(valorTotalCent) : 'a definir pelos comprovantes';
    chamado = Object.assign(base, {
      colaborador,
      compra: null,
      veiculo: null,
      condutor: null,
      rota: '',
      dataViagem: dataIda,   // entra nos relatórios pela data de ida
      anexos: { hotel: [], passagem: [], alimentacao: [] },
      adiantamentoCent: 0,
      saldoCent: 0,
      adiantamentoPagoEm: null,
      encerramentoConfirmadoEm: null,
      lembreteSaldoEm: null,
      saldoPagoEm: null,
      compraPagaEm: null,
      // aberto → finalizado (pagamento registrado) | cancelado
    });
    historico(chamado, ctx.usuario, 'Chamado de viagem de colaborador aberto.',
      colaborador.nome + ' · ' + colaborador.destino +
      ' · Ida ' + dataViagemFmt(dataIda) +
      (colaborador.dataVolta ? ' · Volta ' + dataViagemFmt(colaborador.dataVolta) : '') +
      ' · Valor ' + valorTxt);
    d.db.chamados.push(chamado);
    auditar(ctx.usuario, 'Abriu chamado de viagem de colaborador ' + chamado.id,
      colaborador.nome + ' · ' + colaborador.destino + ' · ida ' + dataViagemFmt(dataIda) +
      ' · Valor ' + valorTxt, ctx.ip);
    criarNotificacao(
      'novo_chamado', chamado,
      'Nova viagem de colaborador ' + chamado.id + ' — ' + ctx.usuario.nome,
      'Solicitante: ' + ctx.usuario.nome +
        '. Colaborador: ' + colaborador.nome +
        '. Destino: ' + colaborador.destino +
        '. Ida: ' + dataViagemFmt(dataIda) +
        (colaborador.dataVolta ? '. Volta: ' + dataViagemFmt(colaborador.dataVolta) : '') +
        (colaborador.motivo ? '. Motivo: ' + colaborador.motivo : '') +
        '. Valor: ' + valorTxt + '.'
    );
  } else {
    // Chamado de VIAGEM (adiantamento 70/30).
    const v = ctx.body.veiculo || {};
    const c = ctx.body.condutor || {};
    const placa = normPlaca(v.placa);
    if (placa === '' || placa === null) {
      return erro(ctx.res, 400, 'Placa inválida. Use o modelo brasileiro (ABC-1234) ou Mercosul (ABC1D23).');
    }
    const telefone = normTelefone(c.telefone);
    if (telefone === null) return erro(ctx.res, 400, 'Telefone inválido. Use DDD + número: (00) 90000-0000.');
    const documento = normCpf(c.documento);
    if (documento === null) return erro(ctx.res, 400, 'CPF inválido. Digite os 11 números de um CPF válido.');
    const cnh = normCnh(c.cnh);
    if (cnh === null) return erro(ctx.res, 400, 'CNH inválida. Digite os 11 números do registro da CNH.');
    const dataViagem = normDataViagem(ctx.body.dataViagem);
    if (!dataViagem) return erro(ctx.res, 400, 'Informe a data da viagem.');
    const veiculo = {
      placa,
      modelo: txt(v.modelo, 80),
      ano: txt(v.ano, 8),
      km: txt(v.km, 12).replace(/\D/g, ''),
    };
    const condutor = { nome: txt(c.nome, 80), documento, cnh, telefone };
    if (!veiculo.modelo) return erro(ctx.res, 400, 'Informe o modelo do veículo.');
    if (!condutor.nome) return erro(ctx.res, 400, 'Informe o nome do condutor.');

    const adiantamentoCent = Math.round(valorTotalCent * 0.7);
    const saldoCent = valorTotalCent - adiantamentoCent;
    chamado = Object.assign(base, {
      veiculo,
      condutor,
      rota: txt(ctx.body.rota, 200),
      dataViagem,
      adiantamentoCent,
      saldoCent,
      // aberto → adiantamento_pago → viagem_encerrada → finalizado | cancelado
      adiantamentoPagoEm: null,
      encerramentoConfirmadoEm: null,
      lembreteSaldoEm: null,
      saldoPagoEm: null,
    });
    historico(chamado, ctx.usuario, 'Chamado aberto.',
      'Valor total ' + reaisFmt(valorTotalCent) + ' · Adiantamento (70%) ' + reaisFmt(adiantamentoCent) +
      ' · Saldo ' + reaisFmt(saldoCent) +
      ' · Viagem em ' + dataViagemFmt(dataViagem) +
      (chamado.rota ? ' · Rota: ' + chamado.rota : ''));
    d.db.chamados.push(chamado);
    auditar(ctx.usuario, 'Abriu chamado de viagem ' + chamado.id,
      veiculo.placa + ' · ' + condutor.nome + ' · viagem ' + dataViagemFmt(dataViagem) +
      (chamado.rota ? ' · ' + chamado.rota : '') + ' · ' + reaisFmt(valorTotalCent), ctx.ip);
    criarNotificacao(
      'novo_chamado', chamado,
      'Novo chamado ' + chamado.id + ' — ' + ctx.usuario.nome,
      'Solicitante: ' + ctx.usuario.nome +
        '. Veículo: ' + veiculo.placa + ' (' + veiculo.modelo + ')' +
        '. Condutor: ' + condutor.nome +
        '. Viagem: ' + dataViagemFmt(dataViagem) +
        (chamado.rota ? '. Rota: ' + chamado.rota : '') +
        '. Valor total: ' + reaisFmt(valorTotalCent) +
        '. Adiantamento (70%): ' + reaisFmt(adiantamentoCent) +
        '. Saldo: ' + reaisFmt(saldoCent) + '.'
    );
  }
  d.flush();
  notifyChange('chamados');
  sendJson(ctx.res, 200, { chamado });
});

rota('GET', '/api/chamados/:id', null, (ctx) => {
  const chamado = acharChamado(ctx.params.id);
  if (!chamado) return erro(ctx.res, 404, 'Chamado não encontrado.');
  if (!podeVerChamado(ctx.usuario, chamado)) return erro(ctx.res, 403, 'Sem permissão para ver este chamado.');
  sendJson(ctx.res, 200, { chamado });
});

rota('POST', '/api/chamados/:id/adiantamento-pago', ['financeiro', 'admin'], (ctx) => {
  const chamado = acharChamado(ctx.params.id);
  if (!chamado) return erro(ctx.res, 404, 'Chamado não encontrado.');
  if (chamado.tipo !== 'viagem') return erro(ctx.res, 400, 'Só chamados de transporte têm adiantamento 70/30.');
  if (chamado.status === 'cancelado') return erro(ctx.res, 400, 'Chamado cancelado.');
  if (chamado.adiantamentoPagoEm) return erro(ctx.res, 400, 'Adiantamento já registrado como pago.');
  chamado.adiantamentoPagoEm = d.agora();
  if (chamado.status === 'aberto') chamado.status = 'adiantamento_pago';
  historico(chamado, ctx.usuario, 'Adiantamento pago (' + reaisFmt(chamado.adiantamentoCent) + ').');
  reconhecerNotificacoesDoChamado(chamado.id, ctx.usuario, ['novo_chamado']);
  auditar(ctx.usuario, 'Marcou adiantamento como pago', chamado.id + ' · ' + reaisFmt(chamado.adiantamentoCent), ctx.ip);
  d.flush();
  notifyChange('chamados');
  sendJson(ctx.res, 200, { chamado });
});

rota('POST', '/api/chamados/:id/encerrar-viagem', null, (ctx) => {
  const chamado = acharChamado(ctx.params.id);
  if (!chamado) return erro(ctx.res, 404, 'Chamado não encontrado.');
  if (!podeVerChamado(ctx.usuario, chamado)) return erro(ctx.res, 403, 'Sem permissão.');
  if (chamado.tipo !== 'viagem') return erro(ctx.res, 400, 'Só chamados de transporte têm encerramento de viagem.');
  if (chamado.status === 'cancelado') return erro(ctx.res, 400, 'Chamado cancelado.');
  if (chamado.encerramentoConfirmadoEm) return erro(ctx.res, 400, 'Encerramento já confirmado.');
  chamado.encerramentoConfirmadoEm = d.agora();
  if (chamado.status !== 'finalizado') chamado.status = 'viagem_encerrada';
  const dataLembrete = new Date(Date.now() + LEMBRETE_MS);
  historico(chamado, ctx.usuario, 'Encerramento da viagem confirmado.',
    'Lembrete do saldo será gerado em ' + dataLembrete.toLocaleDateString('pt-BR') + '.');
  criarNotificacao(
    'viagem_encerrada', chamado,
    'Viagem encerrada — chamado ' + chamado.id,
    ctx.usuario.nome + ' confirmou o encerramento da viagem. Saldo de ' + reaisFmt(chamado.saldoCent) +
      ' a pagar. Lembrete automático em ' + dataLembrete.toLocaleDateString('pt-BR') + ' (5 dias).'
  );
  auditar(ctx.usuario, 'Confirmou encerramento da viagem', chamado.id + ' · saldo ' + reaisFmt(chamado.saldoCent) + ' a pagar', ctx.ip);
  d.flush();
  notifyChange('chamados');
  sendJson(ctx.res, 200, { chamado });
});

rota('POST', '/api/chamados/:id/saldo-pago', ['financeiro', 'admin'], (ctx) => {
  const chamado = acharChamado(ctx.params.id);
  if (!chamado) return erro(ctx.res, 404, 'Chamado não encontrado.');
  if (chamado.tipo !== 'viagem') return erro(ctx.res, 400, 'Só chamados de transporte têm saldo 70/30.');
  if (chamado.status === 'cancelado') return erro(ctx.res, 400, 'Chamado cancelado.');
  if (chamado.saldoPagoEm) return erro(ctx.res, 400, 'Saldo já registrado como pago.');
  if (!chamado.encerramentoConfirmadoEm) return erro(ctx.res, 400, 'Confirme o encerramento da viagem antes de pagar o saldo.');
  chamado.saldoPagoEm = d.agora();
  chamado.status = 'finalizado';
  historico(chamado, ctx.usuario, 'Saldo pago (' + reaisFmt(chamado.saldoCent) + '). Chamado finalizado.');
  reconhecerNotificacoesDoChamado(chamado.id, ctx.usuario, null); // encerra todos os avisos deste chamado
  auditar(ctx.usuario, 'Marcou saldo como pago (chamado finalizado)', chamado.id + ' · ' + reaisFmt(chamado.saldoCent), ctx.ip);
  d.flush();
  notifyChange('chamados');
  sendJson(ctx.res, 200, { chamado });
});

// Compra e viagem de colaborador: pagamento único registrado pelo financeiro.
rota('POST', '/api/chamados/:id/compra-paga', ['financeiro', 'admin'], (ctx) => {
  const chamado = acharChamado(ctx.params.id);
  if (!chamado) return erro(ctx.res, 404, 'Chamado não encontrado.');
  if (chamado.tipo !== 'compra' && chamado.tipo !== 'colaborador') {
    return erro(ctx.res, 400, 'Este chamado não é de pagamento único.');
  }
  if (chamado.status === 'cancelado') return erro(ctx.res, 400, 'Chamado cancelado.');
  if (chamado.compraPagaEm) return erro(ctx.res, 400, 'Pagamento já registrado.');
  // O financeiro pode informar/ajustar o valor no momento do pagamento
  // (compras e viagens de colaborador podem ser abertas sem valor).
  const valorInformado = centavos(ctx.body.valorTotalCent);
  if (valorInformado) chamado.valorTotalCent = valorInformado;
  const oQue = chamado.tipo === 'colaborador' ? 'Viagem do colaborador paga' : 'Compra paga';
  const valorTxt = chamado.valorTotalCent ? ' (' + reaisFmt(chamado.valorTotalCent) + ')' : '';
  chamado.compraPagaEm = d.agora();
  chamado.status = 'finalizado';
  historico(chamado, ctx.usuario, oQue + valorTxt + '. Chamado finalizado.');
  reconhecerNotificacoesDoChamado(chamado.id, ctx.usuario, null);
  auditar(ctx.usuario, 'Registrou pagamento único (chamado finalizado)',
    chamado.id + (valorTxt ? ' ·' + valorTxt : ''), ctx.ip);
  d.flush();
  notifyChange('chamados');
  sendJson(ctx.res, 200, { chamado });
});

rota('POST', '/api/chamados/:id/cancelar', ['admin'], (ctx) => {
  const chamado = acharChamado(ctx.params.id);
  if (!chamado) return erro(ctx.res, 404, 'Chamado não encontrado.');
  if (chamado.status === 'finalizado') return erro(ctx.res, 400, 'Chamado já finalizado.');
  chamado.status = 'cancelado';
  historico(chamado, ctx.usuario, 'Chamado cancelado.', txt(ctx.body.motivo, 300) || null);
  reconhecerNotificacoesDoChamado(chamado.id, ctx.usuario, null);
  auditar(ctx.usuario, 'Cancelou chamado', chamado.id + (txt(ctx.body.motivo, 300) ? ' · motivo: ' + txt(ctx.body.motivo, 300) : ''), ctx.ip);
  d.flush();
  notifyChange('chamados');
  sendJson(ctx.res, 200, { chamado });
});

// ---- anexos ------------------------------------------------------------------
// Transporte: fotos de entrada e saída da viagem.
// Viagem de colaborador: comprovantes de hotel, passagens e alimentação.
function categoriasAnexo(chamado) {
  return chamado.tipo === 'colaborador'
    ? { hotel: 'Comprovante de hotel', passagem: 'Comprovante de passagem', alimentacao: 'Comprovante de alimentação' }
    : { entrada: 'Foto de entrada', saida: 'Foto de saída' };
}

rota('POST', '/api/chamados/:id/anexos', null, (ctx) => {
  const chamado = acharChamado(ctx.params.id);
  if (!chamado) return erro(ctx.res, 404, 'Chamado não encontrado.');
  if (!podeVerChamado(ctx.usuario, chamado)) return erro(ctx.res, 403, 'Sem permissão.');
  if (chamado.status === 'cancelado') return erro(ctx.res, 400, 'Chamado cancelado.');
  const categorias = categoriasAnexo(chamado);
  const tipo = categorias[ctx.body.tipo] ? String(ctx.body.tipo) : null;
  if (!tipo) {
    return erro(ctx.res, 400, 'Tipo do anexo deve ser: ' + Object.keys(categorias).join(', ') + '.');
  }
  const mime = String(ctx.body.mime || '');
  const ext = IMAGENS[mime];
  if (!ext) return erro(ctx.res, 400, 'Envie uma imagem PNG, JPG, WEBP ou GIF.');
  let b64 = String(ctx.body.dataBase64 || '');
  const m = b64.match(/^data:[^;]+;base64,(.*)$/s);
  if (m) b64 = m[1];
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch (e) { return erro(ctx.res, 400, 'Imagem inválida.'); }
  if (!buf || buf.length < 100) return erro(ctx.res, 400, 'Imagem vazia ou inválida.');
  if (buf.length > ANEXO_MAX) return erro(ctx.res, 400, 'Imagem grande demais (máx. 12 MB).');

  const anexoId = d.novoIdAnexo();
  const dir = path.join(d.ANEXOS_DIR, chamado.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, anexoId + ext), buf);
  const anexo = {
    id: anexoId,
    nome: txt(ctx.body.nome, 120) || (tipo + ext),
    mime,
    ext,
    tamanho: buf.length,
    em: d.agora(),
    por: ctx.usuario.nome,
  };
  if (!chamado.anexos[tipo]) chamado.anexos[tipo] = [];
  chamado.anexos[tipo].push(anexo);
  historico(chamado, ctx.usuario, categorias[tipo] + ' anexado(a).', anexo.nome);
  auditar(ctx.usuario, 'Anexou: ' + categorias[tipo].toLowerCase(), chamado.id + ' · ' + anexo.nome, ctx.ip);
  d.flush();
  notifyChange('chamados');
  sendJson(ctx.res, 200, { anexo, chamado });
});

rota('GET', '/api/chamados/:id/anexos/:anexoId', null, (ctx) => {
  const chamado = acharChamado(ctx.params.id);
  if (!chamado) return erro(ctx.res, 404, 'Chamado não encontrado.');
  if (!podeVerChamado(ctx.usuario, chamado)) return erro(ctx.res, 403, 'Sem permissão.');
  const anexo = Object.values(chamado.anexos)
    .reduce((todos, lista) => todos.concat(lista), [])
    .find((a) => a.id === ctx.params.anexoId);
  if (!anexo) return erro(ctx.res, 404, 'Anexo não encontrado.');
  const file = path.join(d.ANEXOS_DIR, chamado.id, anexo.id + anexo.ext);
  fs.readFile(file, (err, data) => {
    if (err) return erro(ctx.res, 404, 'Arquivo do anexo não encontrado no servidor.');
    send(ctx.res, 200, data, { 'Content-Type': anexo.mime, 'Cache-Control': 'private, max-age=3600' });
  });
});

rota('DELETE', '/api/chamados/:id/anexos/:anexoId', null, (ctx) => {
  const chamado = acharChamado(ctx.params.id);
  if (!chamado) return erro(ctx.res, 404, 'Chamado não encontrado.');
  if (!podeVerChamado(ctx.usuario, chamado)) return erro(ctx.res, 403, 'Sem permissão.');
  if (chamado.status === 'finalizado') return erro(ctx.res, 400, 'Chamado finalizado: anexos não podem mais ser removidos.');
  const categorias = categoriasAnexo(chamado);
  for (const tipo of Object.keys(chamado.anexos)) {
    const i = chamado.anexos[tipo].findIndex((a) => a.id === ctx.params.anexoId);
    if (i >= 0) {
      const anexo = chamado.anexos[tipo][i];
      const rotulo = categorias[tipo] || 'Anexo';
      chamado.anexos[tipo].splice(i, 1);
      try { fs.unlinkSync(path.join(d.ANEXOS_DIR, chamado.id, anexo.id + anexo.ext)); } catch (e) { /* ignore */ }
      historico(chamado, ctx.usuario, rotulo + ' removido(a).', anexo.nome);
      auditar(ctx.usuario, 'Removeu: ' + rotulo.toLowerCase(), chamado.id + ' · ' + anexo.nome, ctx.ip);
      d.flush();
      notifyChange('chamados');
      return sendJson(ctx.res, 200, { ok: true, chamado });
    }
  }
  erro(ctx.res, 404, 'Anexo não encontrado.');
});

// ---- notificações ------------------------------------------------------------
rota('GET', '/api/notificacoes', ['financeiro', 'admin'], (ctx) => {
  const lista = d.db.notificacoes.slice().sort((a, b) => (a.em < b.em ? 1 : -1)).slice(0, 100);
  sendJson(ctx.res, 200, { notificacoes: lista });
});

rota('GET', '/api/notificacoes/pendentes', ['financeiro', 'admin'], (ctx) => {
  verificarLembretes(); // aproveita a consulta do notificador para checar os 5 dias
  const lista = d.db.notificacoes.filter((n) => !n.reconhecidaPor);
  sendJson(ctx.res, 200, { notificacoes: lista });
});

rota('POST', '/api/notificacoes/:id/reconhecer', ['financeiro', 'admin'], (ctx) => {
  const n = d.db.notificacoes.find((x) => x.id === ctx.params.id);
  if (!n) return erro(ctx.res, 404, 'Notificação não encontrada.');
  if (!n.reconhecidaPor) {
    n.reconhecidaPor = { id: ctx.usuario.id, nome: ctx.usuario.nome, em: d.agora() };
    auditar(ctx.usuario, 'Marcou notificação como vista', n.id + ' · ' + n.titulo, ctx.ip);
    d.flush();
    notifyChange('notificacoes');
  }
  sendJson(ctx.res, 200, { notificacao: n });
});

// ---- relatórios (apenas quem visualiza os chamados: financeiro/admin) --------
// Movimento completo: viagens e compras, para o front montar as listas
// separadas e a combinada por dia.
rota('GET', '/api/relatorios/movimento', ['financeiro', 'admin'], (ctx) => {
  const itens = d.db.chamados
    .slice()
    .sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : -1))
    .map((c) => ({
      id: c.id,
      tipo: c.tipo || 'viagem',
      criadoEm: c.criadoEm,
      solicitante: c.solicitante.nome,
      descricao: c.tipo === 'compra'
        ? (c.compra ? c.compra.descricao : '')
        : c.tipo === 'colaborador'
          ? (c.colaborador ? 'Colaborador — ' + c.colaborador.destino : '')
          : (c.veiculo ? (c.veiculo.placa + ' · ' + c.veiculo.modelo) : ''),
      fornecedor: (c.tipo === 'compra' && c.compra) ? c.compra.fornecedor : '',
      condutor: c.tipo === 'colaborador'
        ? (c.colaborador ? c.colaborador.nome : '')
        : (c.tipo !== 'compra' && c.condutor) ? c.condutor.nome : '',
      rota: c.rota || '',
      dataViagem: c.dataViagem || null,
      valorTotalCent: c.valorTotalCent,
      adiantamentoCent: c.adiantamentoCent || 0,
      saldoCent: c.saldoCent || 0,
      adiantamentoPagoEm: c.adiantamentoPagoEm || null,
      saldoPagoEm: c.saldoPagoEm || null,
      compraPagaEm: c.compraPagaEm || null,
      encerramentoConfirmadoEm: c.encerramentoConfirmadoEm || null,
      status: c.status,
    }));
  sendJson(ctx.res, 200, { itens });
});

// ---- auditoria (apenas financeiro/admin) --------------------------------------
rota('GET', '/api/auditoria', ['financeiro', 'admin'], (ctx) => {
  const eventos = d.db.auditoria.slice(-500).reverse(); // mais recentes primeiro
  sendJson(ctx.res, 200, { eventos });
});

// ---- cadastro de frota e motoristas -------------------------------------------
// Gerado pela ferramenta importar-cadastro.py (planilha da programação +
// frota CertaDoc). Alimenta o autocompletar do "Novo chamado" e a aba
// Telefones; recarrega sozinho quando os arquivos mudam. Correções manuais
// de CPF/telefone ficam em cadastro-correcoes.json — arquivo separado para
// que uma reimportação da planilha não desfaça o que foi corrigido à mão.
let cadastroCache = { mtime: 0, mtimeCor: 0, dados: null };
function arqCorrecoes() { return path.join(d.DATA_DIR, 'cadastro-correcoes.json'); }
function lerCorrecoes() {
  try { return JSON.parse(fs.readFileSync(arqCorrecoes(), 'utf8')); }
  catch (_) { return { motoristas: {} }; }
}
function lerCadastro() {
  const arq = path.join(d.DATA_DIR, 'cadastro.json');
  try {
    const st = fs.statSync(arq);
    let stCor = 0;
    try { stCor = fs.statSync(arqCorrecoes()).mtimeMs; } catch (_) { /* ainda sem correções */ }
    if (!cadastroCache.dados || st.mtimeMs !== cadastroCache.mtime || stCor !== cadastroCache.mtimeCor) {
      const dados = JSON.parse(fs.readFileSync(arq, 'utf8'));
      const cor = lerCorrecoes().motoristas || {};
      for (const m of dados.motoristas || []) {
        const c = cor[m.nome.trim().toUpperCase()];
        if (c) {
          if (typeof c.cpf === 'string') m.cpf = c.cpf;
          if (typeof c.telefone === 'string') m.telefone = c.telefone;
        }
      }
      cadastroCache = { mtime: st.mtimeMs, mtimeCor: stCor, dados };
    }
    return cadastroCache.dados;
  } catch (_) {
    return { atualizadoEm: null, veiculos: [], motoristas: [] };
  }
}
rota('GET', '/api/cadastro', null, (ctx) => {
  sendJson(ctx.res, 200, lerCadastro());
});

// Correção manual do CPF/telefone de um condutor (qualquer usuário logado):
// usada pelo "Novo chamado" e pela aba Telefones quando o dado importado da
// planilha está errado. Fica registrada na auditoria.
rota('POST', '/api/cadastro/motorista', null, (ctx) => {
  const nome = txt(ctx.body.nome, 120).trim();
  const m = (lerCadastro().motoristas || [])
    .find((x) => x.nome.trim().toUpperCase() === nome.toUpperCase());
  if (!m) return erro(ctx.res, 404, 'Condutor não encontrado no cadastro.');
  const cpf = txt(ctx.body.cpf, 14).trim();
  const telefone = txt(ctx.body.telefone, 15).trim();
  if (cpf && !/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(cpf)) {
    return erro(ctx.res, 400, 'CPF inválido: use o formato 000.000.000-00.');
  }
  if (telefone && !/^\(\d{2}\) \d{4,5}-\d{4}$/.test(telefone)) {
    return erro(ctx.res, 400, 'Telefone inválido: use o formato (00) 90000-0000.');
  }
  const correcoes = lerCorrecoes();
  if (!correcoes.motoristas) correcoes.motoristas = {};
  correcoes.motoristas[m.nome.trim().toUpperCase()] = {
    cpf, telefone,
    por: ctx.usuario.nome,
    em: d.agora(),
  };
  const tmp = arqCorrecoes() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(correcoes, null, 1));
  fs.renameSync(tmp, arqCorrecoes());
  cadastroCache.dados = null; // re-mescla as correções na próxima leitura
  auditar(ctx.usuario, 'Corrigiu o cadastro do condutor ' + m.nome,
    'CPF: ' + (cpf || '(vazio)') + ' · Telefone: ' + (telefone || '(vazio)'), ctx.ip);
  d.flush();
  sendJson(ctx.res, 200, { motorista: Object.assign({}, m, { cpf, telefone }) });
});

// ---- backup ------------------------------------------------------------------
rota('GET', '/api/export', ['admin'], (ctx) => {
  // Exporta a base completa (inclui hashes de senha e sessões): registra na
  // auditoria quem baixou e quando.
  auditar(ctx.usuario, 'Exportou a base completa (backup)', null, ctx.ip);
  d.flush();
  sendJson(ctx.res, 200, d.db);
});

// ---------------------------------------------------------------------------
// Despacho HTTP.
// ---------------------------------------------------------------------------
function handleApi(req, res) {
  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (c) => {
    if (tooBig) return;
    size += c.length;
    if (size > BODY_LIMIT) {
      tooBig = true;
      erro(res, 413, 'Arquivo grande demais para o servidor.');
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    let body = {};
    if (chunks.length) {
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      catch (e) { return erro(res, 400, 'JSON inválido no corpo da requisição.'); }
    }
    const u = new URL(req.url, 'http://x');
    const urlPath = u.pathname;
    const query = u.searchParams;
    const ip = (req.socket && req.socket.remoteAddress) || '?';
    const token = req.headers['x-token'] || query.get('token') || '';

    for (const r of rotas) {
      if (r.metodo !== req.method) continue;
      const m = r.re.exec(urlPath);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { try { params[k] = decodeURIComponent(m[i + 1]); } catch (e) { params[k] = m[i + 1]; } });

      const anon = Array.isArray(r.papeis) && r.papeis.includes('anon');
      let usuario = null;
      if (!anon) {
        usuario = d.usuarioPorToken(token);
        if (!usuario) return erro(res, 401, 'Sessão inválida ou expirada. Entre novamente.');
        if (Array.isArray(r.papeis) && r.papeis.length && !r.papeis.includes(usuario.papel)) {
          return erro(res, 403, 'Seu perfil não tem permissão para esta ação.');
        }
      }
      try {
        return r.handler({ req, res, usuario, body, params, query, ip, token });
      } catch (e) {
        console.error('[Chamados] erro na rota ' + req.method + ' ' + urlPath + ':', e);
        return erro(res, 500, 'Erro interno do servidor.');
      }
    }
    erro(res, 404, 'Rota não encontrada.');
  });
  req.on('error', () => { if (!res.writableEnded) send(res, 400, 'Erro na requisição'); });
}

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
  catch (e) { return send(res, 400, 'Bad request'); }
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    return send(res, 403, 'Forbidden');
  }
  // Não expor o código do servidor pela web.
  const blocked = [path.join(ROOT, 'server')];
  if (blocked.some((b) => filePath === b || filePath.startsWith(b + path.sep))) {
    return send(res, 403, 'Forbidden');
  }
  // Não servir arquivos sensíveis/ocultos mesmo dentro da pasta web
  // (logs, scripts de automação, ocultos como .git, backups .bak).
  const base = path.basename(filePath);
  const EXT_BLOQUEADAS = ['.log', '.bat', '.vbs', '.ps1', '.bak'];
  if (base.startsWith('.') || EXT_BLOQUEADAS.includes(path.extname(filePath).toLowerCase())) {
    return send(res, 403, 'Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Não encontrado');
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/events' && req.method === 'GET') {
    return handleSSE(req, res, u.searchParams);
  }
  if (u.pathname === '/api' || u.pathname.startsWith('/api/')) {
    return handleApi(req, res);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Método não permitido');
  }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`[Chamados Financeiros] servidor no ar em http://${HOST}:${PORT}`);
  console.log(`[Chamados Financeiros] dados em: ${d.DATA_FILE}`);
  console.log(`[Chamados Financeiros] anexos em: ${d.ANEXOS_DIR}`);
  console.log(`[Chamados Financeiros] lembrete do saldo: ${Math.round(LEMBRETE_MS / 3600000)}h após o encerramento`);
});

// Verificador do lembrete de 5 dias (roda a cada 5 minutos).
const CHECK_MS = Math.min(5 * 60 * 1000, Math.max(5000, Math.floor(LEMBRETE_MS / 4)));
setInterval(() => { try { verificarLembretes(); } catch (e) { console.error('[Chamados] lembretes:', e); } }, CHECK_MS).unref();
verificarLembretes();

// Snapshot automático periódico + limpeza de sessões vencidas.
setInterval(() => {
  try { d.snapshot('auto'); } catch (e) { /* ignore */ }
  try { d.limparSessoes(); } catch (e) { /* ignore */ }
}, 6 * 60 * 60 * 1000).unref();
