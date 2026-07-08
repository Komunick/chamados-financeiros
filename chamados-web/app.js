'use strict';
/*
 * Chamados Financeiros — front-end (HTML/CSS/JS puro, sem dependências).
 * Fala com o servidor via /api/* e recebe atualizações em tempo real por SSE.
 */
(function () {
  // ------------------------------------------------------------------ estado
  const state = {
    token: localStorage.getItem('chamados.token') || '',
    usuario: null,
    chamados: [],
    notificacoes: [],
    abaDetalhe: 'financeiro',
    filtroStatus: '',
    filtroBusca: '',
    sse: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs, ...filhos) => {
    const n = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') n.className = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v);
      }
    }
    for (const f of filhos) {
      if (f === null || f === undefined) continue;
      n.append(f.nodeType ? f : document.createTextNode(String(f)));
    }
    return n;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ------------------------------------------------------------------ helpers
  const fmtMoeda = (cent) => (cent / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtData = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  };
  // "1.500,00" / "1500,5" / "1500" → centavos (int) ou null
  function parseMoeda(str) {
    let s = String(str || '').trim().replace(/[R$\s]/g, '');
    if (!s) return null;
    s = s.replace(/\./g, '').replace(',', '.');
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n * 100);
  }
  const STATUS_LABEL = {
    aberto: 'Aberto',
    adiantamento_pago: 'Adiantamento pago',
    viagem_encerrada: 'Viagem encerrada',
    finalizado: 'Finalizado',
    cancelado: 'Cancelado',
  };
  const chipStatus = (st) => el('span', { class: 'chip chip-' + st }, STATUS_LABEL[st] || st);
  const ehFinanceiro = () => state.usuario && (state.usuario.papel === 'financeiro' || state.usuario.papel === 'admin');
  const ehAdmin = () => state.usuario && state.usuario.papel === 'admin';

  function toast(msg, tipo, titulo, aoClicar) {
    const t = el('div', { class: 'toast' + (tipo ? ' toast-' + tipo : '') },
      titulo ? el('div', { class: 'toast-titulo' }, titulo) : null,
      el('div', null, msg));
    if (aoClicar) t.addEventListener('click', () => { aoClicar(); t.remove(); });
    $('#toasts').append(t);
    setTimeout(() => t.remove(), tipo === 'notif' ? 12000 : 5000);
  }

  // ------------------------------------------------------------------ API
  async function api(metodo, caminho, corpo) {
    const opts = { method: metodo, headers: { 'X-Token': state.token } };
    if (corpo !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(corpo);
    }
    let resp;
    try {
      resp = await fetch(caminho, opts);
    } catch (e) {
      throw new Error('Sem conexão com o servidor. Verifique a rede.');
    }
    let dados = {};
    try { dados = await resp.json(); } catch (e) { /* corpo vazio */ }
    if (resp.status === 401 && state.usuario) {
      sair(true);
      throw new Error('Sessão expirada. Entre novamente.');
    }
    if (!resp.ok) throw new Error(dados.error || ('Erro ' + resp.status));
    return dados;
  }

  // ------------------------------------------------------------------ sessão
  async function entrar(login, senha) {
    const r = await api('POST', '/api/auth/login', { login, senha });
    state.token = r.token;
    state.usuario = r.usuario;
    localStorage.setItem('chamados.token', r.token);
    iniciarApp();
  }

  function sair(silencioso) {
    if (!silencioso && state.token) { api('POST', '/api/auth/logout').catch(() => {}); }
    state.token = '';
    state.usuario = null;
    localStorage.removeItem('chamados.token');
    if (state.sse) { state.sse.close(); state.sse = null; }
    $('#tela-app').classList.add('oculto');
    $('#tela-login').classList.remove('oculto');
  }

  // ------------------------------------------------------------------ SSE
  function conectarSSE() {
    if (state.sse) state.sse.close();
    const sse = new EventSource('/api/events?token=' + encodeURIComponent(state.token));
    sse.onmessage = (ev) => {
      let dados;
      try { dados = JSON.parse(ev.data); } catch (e) { return; }
      if (dados.tipo === 'mudanca') {
        atualizarSeSeguro(); // recarrega a visão atual (sem apagar formulário em edição)
        if (ehFinanceiro()) atualizarSino();
      } else if (dados.tipo === 'notificacao' && ehFinanceiro()) {
        const n = dados.notificacao;
        tocarAlerta();
        toast(n.mensagem, 'notif', '🔔 ' + n.titulo, () => { location.hash = '#/chamado/' + n.chamadoId; });
        tentarNotificacaoNavegador(n);
        atualizarSino();
      }
    };
    state.sse = sse;
  }

  function tocarAlerta() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
      o.start(); o.stop(ctx.currentTime + 0.6);
    } catch (e) { /* sem áudio */ }
  }

  // Notificação do navegador (funciona em localhost/HTTPS; na rede o
  // notificador de bandeja é quem garante o aviso na barra de tarefas).
  function tentarNotificacaoNavegador(n) {
    try {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'granted') {
        new Notification(n.titulo, { body: n.mensagem, requireInteraction: true, tag: n.id });
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission();
      }
    } catch (e) { /* bloqueado em HTTP */ }
  }

  async function atualizarSino() {
    if (!ehFinanceiro()) return;
    try {
      const r = await api('GET', '/api/notificacoes/pendentes');
      const badge = $('#sino-badge');
      const qtd = r.notificacoes.length;
      badge.textContent = qtd;
      badge.classList.toggle('oculto', qtd === 0);
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ rotas
  function navAtual() {
    return (location.hash || '#/chamados').replace(/^#/, '');
  }

  // Recarrega a visão atual apenas quando é SEGURO: nunca sobre o formulário
  // de novo chamado nem enquanto o usuário digita em algum campo — um
  // re-render reconstruiria o DOM e apagaria o que foi preenchido.
  function atualizarSeSeguro() {
    if (!state.usuario) return;
    if (navAtual() === '/novo') return;
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')) return;
    renderRota();
  }

  function montarNav() {
    const nav = $('#topo-nav');
    nav.innerHTML = '';
    const links = [
      ['#/chamados', '📋 Chamados'],
      ['#/novo', '➕ Novo chamado'],
    ];
    if (ehFinanceiro()) links.push(['#/notificacoes', '🔔 Notificações']);
    if (ehAdmin()) links.push(['#/usuarios', '👤 Usuários']);
    for (const [href, rotulo] of links) {
      const a = el('a', { href }, rotulo);
      if (navAtual() === href.slice(1) || (href === '#/chamados' && navAtual().startsWith('/chamado/'))) a.classList.add('ativo');
      nav.append(a);
    }
  }

  async function renderRota() {
    if (!state.usuario) return;
    montarNav();
    const rota = navAtual();
    const cont = $('#conteudo');
    try {
      if (rota === '/novo') return renderNovo(cont);
      if (rota === '/notificacoes' && ehFinanceiro()) return await renderNotificacoes(cont);
      if (rota === '/usuarios' && ehAdmin()) return await renderUsuarios(cont);
      const m = rota.match(/^\/chamado\/(.+)$/);
      if (m) return await renderDetalhe(cont, decodeURIComponent(m[1]));
      return await renderLista(cont);
    } catch (e) {
      cont.innerHTML = '';
      cont.append(el('div', { class: 'cartao' }, el('p', { class: 'erro' }, e.message)));
    }
  }

  // ------------------------------------------------------------------ lista
  async function renderLista(cont) {
    const r = await api('GET', '/api/chamados');
    state.chamados = r.chamados;
    cont.innerHTML = '';

    const filtros = el('div', { class: 'filtros' },
      el('input', {
        type: 'search', placeholder: 'Buscar por nº, placa, condutor, solicitante…',
        value: state.filtroBusca,
        oninput: (e) => { state.filtroBusca = e.target.value; desenhar(); },
      }),
      (() => {
        const s = el('select', {
          onchange: (e) => { state.filtroStatus = e.target.value; desenhar(); },
        }, el('option', { value: '' }, 'Todos os status'));
        for (const [v, rot] of Object.entries(STATUS_LABEL)) {
          const o = el('option', { value: v }, rot);
          if (state.filtroStatus === v) o.selected = true;
          s.append(o);
        }
        return s;
      })()
    );

    const envolta = el('div', { class: 'tabela-envolta' });
    const cartao = el('div', { class: 'cartao' },
      el('div', { class: 'linha-topo' },
        el('h2', null, 'Chamados'),
        el('a', { href: '#/novo' }, el('button', { class: 'btn btn-primario' }, '➕ Novo chamado'))),
      filtros, envolta);
    cont.append(cartao);

    function desenhar() {
      const b = state.filtroBusca.trim().toLowerCase();
      let lista = state.chamados;
      if (state.filtroStatus) lista = lista.filter((c) => c.status === state.filtroStatus);
      if (b) {
        lista = lista.filter((c) =>
          [c.id, c.veiculo.placa, c.veiculo.modelo, c.condutor.nome, c.solicitante.nome]
            .join(' ').toLowerCase().includes(b));
      }
      envolta.innerHTML = '';
      if (!lista.length) {
        envolta.append(el('div', { class: 'vazio' }, 'Nenhum chamado encontrado. Clique em "Novo chamado" para abrir o primeiro.'));
        return;
      }
      const tabela = el('table', { class: 'lista' },
        el('thead', null, el('tr', null,
          ...['Nº', 'Solicitante', 'Veículo', 'Condutor', 'Valor total', 'Adiantamento (70%)', 'Saldo', 'Status', 'Aberto em']
            .map((h) => el('th', null, h)))));
      const tbody = el('tbody');
      for (const c of lista) {
        tbody.append(el('tr', { onclick: () => { location.hash = '#/chamado/' + c.id; } },
          el('td', null, el('strong', null, c.id)),
          el('td', null, c.solicitante.nome),
          el('td', null, c.veiculo.placa + ' · ' + c.veiculo.modelo),
          el('td', null, c.condutor.nome),
          el('td', null, fmtMoeda(c.valorTotalCent)),
          el('td', null, fmtMoeda(c.adiantamentoCent)),
          el('td', null, fmtMoeda(c.saldoCent)),
          el('td', null, chipStatus(c.status)),
          el('td', { class: 'mudo' }, fmtData(c.criadoEm))));
      }
      tabela.append(tbody);
      envolta.append(tabela);
    }
    desenhar();
  }

  // ------------------------------------------------------------------ novo chamado
  function renderNovo(cont) {
    cont.innerHTML = '';
    const previa = el('div', { class: 'previa-valores oculto' });
    const inputValor = el('input', { type: 'text', inputmode: 'decimal', placeholder: 'Ex.: 1.500,00', required: '' });
    inputValor.addEventListener('input', () => {
      const cent = parseMoeda(inputValor.value);
      if (!cent) { previa.classList.add('oculto'); return; }
      const adiant = Math.round(cent * 0.7);
      previa.classList.remove('oculto');
      previa.innerHTML =
        '<div><div class="rotulo">Adiantamento (70%)</div><div class="num">' + esc(fmtMoeda(adiant)) + '</div></div>' +
        '<div><div class="rotulo">Saldo (30%)</div><div class="num">' + esc(fmtMoeda(cent - adiant)) + '</div></div>' +
        '<div><div class="rotulo">Valor total</div><div class="num">' + esc(fmtMoeda(cent)) + '</div></div>';
    });

    const campo = (rotulo, attrs) => {
      const i = el('input', Object.assign({ type: 'text' }, attrs || {}));
      return { rotulo: el('label', null, rotulo, i), input: i };
    };
    const placa = campo('Placa *', { placeholder: 'ABC-1D23', required: '' });
    const modelo = campo('Marca / modelo *', { placeholder: 'Ex.: VW Constellation 24.280', required: '' });
    const ano = campo('Ano', { placeholder: 'Ex.: 2020' });
    const km = campo('KM atual', { placeholder: 'Ex.: 154.000', inputmode: 'numeric' });
    const cNome = campo('Nome do condutor *', { required: '' });
    const cDoc = campo('CPF', { placeholder: '000.000.000-00' });
    const cCnh = campo('CNH', { placeholder: 'Número da CNH' });
    const cTel = campo('Telefone', { placeholder: '(00) 90000-0000' });
    const obs = el('textarea', { rows: '3', placeholder: 'Destino, motivo da viagem, observações…' });

    const btn = el('button', { class: 'btn btn-primario', type: 'submit' }, 'Abrir chamado');
    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const valorTotalCent = parseMoeda(inputValor.value);
        if (!valorTotalCent) { toast('Informe um valor total válido.', 'erro'); return; }
        btn.disabled = true;
        try {
          const r = await api('POST', '/api/chamados', {
            veiculo: { placa: placa.input.value, modelo: modelo.input.value, ano: ano.input.value, km: km.input.value },
            condutor: { nome: cNome.input.value, documento: cDoc.input.value, cnh: cCnh.input.value, telefone: cTel.input.value },
            valorTotalCent,
            observacoes: obs.value,
          });
          toast('Chamado ' + r.chamado.id + ' aberto. O financeiro foi notificado.', null, '✅ Chamado criado');
          state.abaDetalhe = 'financeiro';
          location.hash = '#/chamado/' + r.chamado.id;
        } catch (err) {
          toast(err.message, 'erro');
        } finally {
          btn.disabled = false;
        }
      },
    },
      el('h3', { class: 'form-secao' }, '🚛 Dados do veículo'),
      el('div', { class: 'form-grade' }, placa.rotulo, modelo.rotulo, ano.rotulo, km.rotulo),
      el('h3', { class: 'form-secao' }, '🧑‍✈️ Dados do condutor'),
      el('div', { class: 'form-grade' }, cNome.rotulo, cDoc.rotulo, cCnh.rotulo, cTel.rotulo),
      el('h3', { class: 'form-secao' }, '💰 Valor do chamado'),
      el('div', { class: 'form-grade' }, el('label', null, 'Valor total (R$) *', inputValor)),
      previa,
      el('h3', { class: 'form-secao' }, '📝 Observações'),
      obs,
      el('div', { class: 'acoes-status' }, btn,
        el('button', { class: 'btn btn-suave', type: 'button', onclick: () => { location.hash = '#/chamados'; } }, 'Cancelar')));

    cont.append(el('div', { class: 'cartao' },
      el('div', { class: 'linha-topo' }, el('h2', null, 'Novo chamado financeiro')),
      el('p', { class: 'mudo' }, 'Preencha os dados do veículo, do condutor e o valor total. O sistema calcula automaticamente o adiantamento de 70% e o saldo de 30%.'),
      form));
  }

  // ------------------------------------------------------------------ detalhe
  async function renderDetalhe(cont, id) {
    const r = await api('GET', '/api/chamados/' + encodeURIComponent(id));
    const c = r.chamado;
    cont.innerHTML = '';

    const abas = [
      ['financeiro', '💰 Adiantamento e saldo'],
      ['anexos', '📷 Anexos da viagem'],
      ['dados', '🚛 Dados'],
      ['historico', '🕓 Histórico'],
    ];
    const corpoAba = el('div');
    const barraAbas = el('div', { class: 'abas' });
    for (const [chave, rotulo] of abas) {
      const b = el('button', { class: 'aba' + (state.abaDetalhe === chave ? ' ativa' : ''), onclick: () => { state.abaDetalhe = chave; renderRota(); } }, rotulo);
      barraAbas.append(b);
    }

    cont.append(el('div', { class: 'cartao' },
      el('div', { class: 'linha-topo' },
        el('h2', null, c.id + ' — ' + c.veiculo.placa),
        el('div', null, chipStatus(c.status))),
      el('p', { class: 'mudo' },
        'Solicitante: ' + c.solicitante.nome + ' · Condutor: ' + c.condutor.nome + ' · Aberto em ' + fmtData(c.criadoEm)),
      barraAbas, corpoAba));

    if (state.abaDetalhe === 'anexos') renderAbaAnexos(corpoAba, c);
    else if (state.abaDetalhe === 'dados') renderAbaDados(corpoAba, c);
    else if (state.abaDetalhe === 'historico') renderAbaHistorico(corpoAba, c);
    else renderAbaFinanceiro(corpoAba, c);
  }

  function renderAbaFinanceiro(corpo, c) {
    const cartaoValor = (rotulo, cent, statusChip, obs, destaque) =>
      el('div', { class: 'valor-cartao' + (destaque ? ' destaque' : '') },
        el('div', { class: 'rotulo' }, rotulo),
        el('div', { class: 'valor' }, fmtMoeda(cent)),
        statusChip ? el('div', null, statusChip) : null,
        obs ? el('div', { class: 'obs' }, obs) : null);

    corpo.append(el('div', { class: 'valores' },
      cartaoValor('Valor total', c.valorTotalCent, null, 'Informado pelo solicitante na abertura.'),
      cartaoValor('Adiantamento (70%)', c.adiantamentoCent,
        c.adiantamentoPagoEm ? el('span', { class: 'chip chip-pago' }, 'Pago em ' + fmtData(c.adiantamentoPagoEm))
          : el('span', { class: 'chip chip-pendente' }, 'Pendente'),
        'Liberado na abertura do chamado.', true),
      cartaoValor('Saldo (30%)', c.saldoCent,
        c.saldoPagoEm ? el('span', { class: 'chip chip-pago' }, 'Pago em ' + fmtData(c.saldoPagoEm))
          : el('span', { class: 'chip chip-pendente' }, 'Pendente'),
        'Pago após o encerramento da viagem.')));

    const acoes = el('div', { class: 'acoes-status' });

    if (ehFinanceiro() && !c.adiantamentoPagoEm && c.status !== 'cancelado') {
      acoes.append(el('button', {
        class: 'btn btn-verde',
        onclick: () => acao('/api/chamados/' + c.id + '/adiantamento-pago', 'Adiantamento registrado como pago.'),
      }, '✔ Marcar adiantamento como pago'));
    }
    if (!c.encerramentoConfirmadoEm && c.status !== 'cancelado') {
      acoes.append(el('button', {
        class: 'btn btn-primario',
        onclick: () => {
          if (confirm('Confirmar o encerramento da viagem? O lembrete de pagamento do saldo será agendado para daqui a 5 dias.')) {
            acao('/api/chamados/' + c.id + '/encerrar-viagem', 'Encerramento confirmado. Lembrete do saldo agendado (5 dias).');
          }
        },
      }, '🏁 Confirmar encerramento da viagem'));
    }
    if (ehFinanceiro() && c.encerramentoConfirmadoEm && !c.saldoPagoEm && c.status !== 'cancelado') {
      acoes.append(el('button', {
        class: 'btn btn-verde',
        onclick: () => acao('/api/chamados/' + c.id + '/saldo-pago', 'Saldo pago. Chamado finalizado.'),
      }, '✔ Marcar saldo como pago'));
    }
    if (ehAdmin() && c.status !== 'finalizado' && c.status !== 'cancelado') {
      acoes.append(el('button', {
        class: 'btn btn-perigo',
        onclick: () => { if (confirm('Cancelar este chamado?')) acao('/api/chamados/' + c.id + '/cancelar', 'Chamado cancelado.'); },
      }, '✖ Cancelar chamado'));
    }
    if (acoes.children.length) corpo.append(acoes);

    if (c.encerramentoConfirmadoEm && !c.saldoPagoEm) {
      const quando = new Date(Date.parse(c.encerramentoConfirmadoEm) + 5 * 24 * 60 * 60 * 1000);
      corpo.append(el('div', { class: 'aviso-lembrete' },
        c.lembreteSaldoEm
          ? '⏰ Lembrete de pagamento do saldo já enviado ao financeiro em ' + fmtData(c.lembreteSaldoEm) + '.'
          : '⏰ Viagem encerrada em ' + fmtData(c.encerramentoConfirmadoEm) +
            '. O financeiro receberá o lembrete de pagamento do saldo em ' + quando.toLocaleDateString('pt-BR') + ' (5 dias após o encerramento).'));
    }

    async function acao(caminho, msg) {
      try {
        await api('POST', caminho, {});
        toast(msg);
        renderRota();
      } catch (e) { toast(e.message, 'erro'); }
    }
  }

  function renderAbaAnexos(corpo, c) {
    const bloqueado = c.status === 'finalizado' || c.status === 'cancelado';
    const grupo = (tipo, titulo, dica) => {
      const g = el('div', { class: 'anexo-grupo' }, el('h4', null, titulo), el('p', { class: 'mudo' }, dica));
      if (!bloqueado) {
        const inputArquivo = el('input', { type: 'file', accept: 'image/*', class: 'oculto' });
        inputArquivo.addEventListener('change', async () => {
          const arquivo = inputArquivo.files[0];
          if (!arquivo) return;
          if (!/^image\//.test(arquivo.type)) { toast('Selecione uma imagem.', 'erro'); return; }
          if (arquivo.size > 12 * 1024 * 1024) { toast('Imagem grande demais (máx. 12 MB).', 'erro'); return; }
          const leitor = new FileReader();
          leitor.onload = async () => {
            try {
              await api('POST', '/api/chamados/' + c.id + '/anexos', {
                tipo, nome: arquivo.name, mime: arquivo.type, dataBase64: leitor.result,
              });
              toast('Foto anexada.');
              renderRota();
            } catch (e) { toast(e.message, 'erro'); }
          };
          leitor.readAsDataURL(arquivo);
        });
        g.append(
          el('button', { class: 'btn btn-suave', onclick: () => inputArquivo.click() }, '📎 Anexar foto de ' + (tipo === 'entrada' ? 'entrada' : 'saída')),
          inputArquivo);
      }
      const minis = el('div', { class: 'anexo-miniaturas' });
      const lista = c.anexos[tipo] || [];
      if (!lista.length) minis.append(el('span', { class: 'mudo' }, 'Nenhuma foto anexada ainda.'));
      for (const a of lista) {
        const url = '/api/chamados/' + c.id + '/anexos/' + a.id + '?token=' + encodeURIComponent(state.token);
        const mini = el('div', { class: 'anexo-mini' },
          el('img', { src: url, alt: a.nome, title: a.nome + ' — enviada por ' + a.por + ' em ' + fmtData(a.em), onclick: () => window.open(url, '_blank') }),
          el('div', { class: 'legenda' }, a.nome));
        if (!bloqueado) {
          mini.append(el('button', {
            class: 'remover', title: 'Remover foto',
            onclick: async () => {
              if (!confirm('Remover esta foto?')) return;
              try { await api('DELETE', '/api/chamados/' + c.id + '/anexos/' + a.id); toast('Foto removida.'); renderRota(); }
              catch (e) { toast(e.message, 'erro'); }
            },
          }, '✕'));
        }
        minis.append(mini);
      }
      g.append(minis);
      return g;
    };
    corpo.append(el('div', { class: 'anexos-grupos' },
      grupo('entrada', '🚚 Entrada da viagem', 'Fotos do veículo/odômetro na SAÍDA da base (início da viagem).'),
      grupo('saida', '🏁 Saída da viagem', 'Fotos do veículo/odômetro no RETORNO (fim da viagem).')));
    if (bloqueado) corpo.append(el('p', { class: 'mudo' }, 'Chamado ' + STATUS_LABEL[c.status].toLowerCase() + ': os anexos estão travados.'));
  }

  function renderAbaDados(corpo, c) {
    const bloco = (titulo, pares) => {
      const dl = el('dl');
      for (const [k, v] of pares) {
        if (!v) continue;
        dl.append(el('dt', null, k), el('dd', null, v));
      }
      return el('div', { class: 'dados-bloco' }, el('h4', null, titulo), dl);
    };
    corpo.append(el('div', { class: 'dados-grade' },
      bloco('🚛 Veículo', [
        ['Placa', c.veiculo.placa], ['Marca / modelo', c.veiculo.modelo],
        ['Ano', c.veiculo.ano], ['KM na abertura', c.veiculo.km],
      ]),
      bloco('🧑‍✈️ Condutor', [
        ['Nome', c.condutor.nome], ['CPF', c.condutor.documento],
        ['CNH', c.condutor.cnh], ['Telefone', c.condutor.telefone],
      ]),
      bloco('📋 Chamado', [
        ['Solicitante', c.solicitante.nome],
        ['Aberto em', fmtData(c.criadoEm)],
        ['Status', STATUS_LABEL[c.status]],
        ['Encerramento da viagem', c.encerramentoConfirmadoEm ? fmtData(c.encerramentoConfirmadoEm) : 'Ainda não confirmado'],
        ['Observações', c.observacoes],
      ])));
  }

  function renderAbaHistorico(corpo, c) {
    const ul = el('ul', { class: 'hist' });
    for (const h of c.historico.slice().reverse()) {
      ul.append(el('li', null,
        el('div', null, el('strong', null, h.acao), h.detalhe ? ' — ' + h.detalhe : ''),
        el('div', { class: 'quando' }, fmtData(h.em) + ' · ' + h.por)));
    }
    corpo.append(ul);
  }

  // ------------------------------------------------------------------ notificações
  async function renderNotificacoes(cont) {
    const r = await api('GET', '/api/notificacoes');
    cont.innerHTML = '';
    const cartao = el('div', { class: 'cartao' },
      el('div', { class: 'linha-topo' }, el('h2', null, 'Notificações'),
        el('span', { class: 'mudo' }, 'Os avisos na barra de tarefas se repetem até serem marcados como vistos.')));
    if (!r.notificacoes.length) cartao.append(el('div', { class: 'vazio' }, 'Nenhuma notificação por enquanto.'));
    for (const n of r.notificacoes) {
      const pendente = !n.reconhecidaPor;
      const item = el('div', { class: 'notif ' + (pendente ? 'pendente' : 'ok') },
        el('div', { class: 'titulo' }, (n.tipo === 'lembrete_saldo' ? '⏰ ' : n.tipo === 'viagem_encerrada' ? '🏁 ' : '🆕 ') + n.titulo),
        el('div', { class: 'quando' }, fmtData(n.em) + (n.reconhecidaPor ? ' · vista por ' + n.reconhecidaPor.nome + ' em ' + fmtData(n.reconhecidaPor.em) : '')),
        el('div', { class: 'mensagem' }, n.mensagem),
        el('div', { class: 'acoes-status' },
          el('button', { class: 'btn btn-suave btn-mini', onclick: () => { state.abaDetalhe = 'financeiro'; location.hash = '#/chamado/' + n.chamadoId; } }, 'Abrir chamado'),
          pendente ? el('button', {
            class: 'btn btn-primario btn-mini',
            onclick: async () => {
              try { await api('POST', '/api/notificacoes/' + n.id + '/reconhecer'); renderRota(); atualizarSino(); }
              catch (e) { toast(e.message, 'erro'); }
            },
          }, '✔ Marcar como visto (para os avisos)') : null));
      cartao.append(item);
    }
    cont.append(cartao);
  }

  // ------------------------------------------------------------------ usuários (admin)
  async function renderUsuarios(cont) {
    const r = await api('GET', '/api/usuarios');
    cont.innerHTML = '';

    const nome = el('input', { type: 'text', placeholder: 'Nome completo' });
    const login = el('input', { type: 'text', placeholder: 'login (sem espaços)' });
    const senha = el('input', { type: 'password', placeholder: 'mínimo 6 caracteres' });
    const papel = el('select', null,
      el('option', { value: 'solicitante' }, 'Solicitante (abre chamados)'),
      el('option', { value: 'financeiro' }, 'Financeiro (recebe notificações)'),
      el('option', { value: 'admin' }, 'Administrador'));
    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('POST', '/api/usuarios', { nome: nome.value, login: login.value, senha: senha.value, papel: papel.value });
          toast('Usuário criado.');
          renderRota();
        } catch (err) { toast(err.message, 'erro'); }
      },
    },
      el('div', { class: 'form-grade' },
        el('label', null, 'Nome', nome), el('label', null, 'Login', login),
        el('label', null, 'Senha', senha), el('label', null, 'Papel', papel)),
      el('div', { class: 'acoes-status' }, el('button', { class: 'btn btn-primario', type: 'submit' }, '➕ Criar usuário')));

    const envolta = el('div', { class: 'tabela-envolta' });
    const tabela = el('table', { class: 'lista' },
      el('thead', null, el('tr', null, ...['Nome', 'Login', 'Papel', 'Ações'].map((h) => el('th', null, h)))));
    const tbody = el('tbody');
    const PAPEL_LABEL = { solicitante: 'Solicitante', financeiro: 'Financeiro', admin: 'Administrador' };
    for (const u of r.usuarios) {
      tbody.append(el('tr', { style: 'cursor:default' },
        el('td', null, u.nome),
        el('td', null, u.login),
        el('td', null, PAPEL_LABEL[u.papel] || u.papel),
        el('td', null,
          el('button', {
            class: 'btn btn-suave btn-mini',
            onclick: async () => {
              const nova = prompt('Nova senha para ' + u.nome + ' (mínimo 6 caracteres):');
              if (!nova) return;
              try { await api('PUT', '/api/usuarios/' + u.id, { novaSenha: nova }); toast('Senha alterada.'); }
              catch (e) { toast(e.message, 'erro'); }
            },
          }, 'Trocar senha'),
          ' ',
          el('button', {
            class: 'btn btn-perigo btn-mini',
            onclick: async () => {
              if (!confirm('Remover o usuário ' + u.nome + '?')) return;
              try { await api('DELETE', '/api/usuarios/' + u.id); toast('Usuário removido.'); renderRota(); }
              catch (e) { toast(e.message, 'erro'); }
            },
          }, 'Remover'))));
    }
    tabela.append(tbody);
    envolta.append(tabela);

    cont.append(el('div', { class: 'cartao' },
      el('div', { class: 'linha-topo' }, el('h2', null, 'Usuários')),
      el('h3', { class: 'form-secao' }, '➕ Novo usuário'), form,
      el('h3', { class: 'form-secao' }, '👥 Usuários cadastrados'), envolta));
  }

  // ------------------------------------------------------------------ inicialização
  async function iniciarApp() {
    $('#tela-login').classList.add('oculto');
    $('#tela-app').classList.remove('oculto');
    $('#usuario-nome').textContent = state.usuario.nome + ' (' + state.usuario.papel + ')';
    $('#sino').classList.toggle('oculto', !ehFinanceiro());
    if (ehFinanceiro()) {
      atualizarSino();
      // Pede permissão de notificação do navegador (funciona em localhost/HTTPS).
      try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (e) { /* ignore */ }
    }
    conectarSSE();
    renderRota();
  }

  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const erroEl = $('#login-erro');
    erroEl.classList.add('oculto');
    try {
      await entrar($('#login-usuario').value.trim(), $('#login-senha').value);
    } catch (err) {
      erroEl.textContent = err.message;
      erroEl.classList.remove('oculto');
    }
  });

  $('#btn-sair').addEventListener('click', () => sair(false));
  $('#sino').addEventListener('click', () => { location.hash = '#/notificacoes'; });
  window.addEventListener('hashchange', renderRota);

  // Atualização de segurança caso o SSE caia: recarrega a visão a cada 60 s
  // (pula formulários em edição para não apagar o que o usuário digitou).
  setInterval(atualizarSeSeguro, 60000);

  (async function boot() {
    if (state.token) {
      try {
        const r = await api('GET', '/api/me');
        state.usuario = r.usuario;
        return iniciarApp();
      } catch (e) { /* token vencido → login */ }
    }
    sair(true);
  })();
})();
