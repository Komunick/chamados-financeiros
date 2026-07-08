'use strict';
/*
 * Brazil Transports — Chamados Financeiros — front-end (HTML/CSS/JS puro).
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
    abaRelatorio: 'dia',
    filtroBuscaAud: '',
    filtroStatus: '',
    filtroBusca: '',
    filtroStatusHist: '',
    filtroBuscaHist: '',
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
  // 'AAAA-MM-DD' → 'DD/MM/AAAA' (sem fuso: é só texto)
  const fmtDataViagem = (s) => {
    if (!s) return '—';
    const p = String(s).split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : s;
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
  const STATUS_ATIVOS = ['aberto', 'adiantamento_pago', 'viagem_encerrada'];
  const STATUS_HISTORICO = ['finalizado', 'cancelado'];
  const TIPO_LABEL = { viagem: 'Viagem', compra: 'Compra' };
  const chipStatus = (st) => el('span', { class: 'chip chip-' + st }, STATUS_LABEL[st] || st);
  const chipTipo = (t) => el('span', { class: 'chip chip-tipo-' + (t || 'viagem') }, TIPO_LABEL[t || 'viagem']);
  const ehFinanceiro = () => state.usuario && (state.usuario.papel === 'financeiro' || state.usuario.papel === 'admin');
  const ehAdmin = () => state.usuario && state.usuario.papel === 'admin';
  const resumoChamado = (c) => c.tipo === 'compra'
    ? (c.compra ? c.compra.descricao : '')
    : (c.veiculo ? c.veiculo.placa + ' · ' + c.veiculo.modelo : '');

  // ------------------------------------------------- máscaras (padrão BR)
  const soDigitos = (s) => String(s || '').replace(/\D/g, '');
  function mascaraTelefone(d) {
    d = soDigitos(d).slice(0, 11);
    if (!d) return '';
    if (d.length <= 2) return '(' + d;
    if (d.length <= 6) return '(' + d.slice(0, 2) + ') ' + d.slice(2);
    if (d.length <= 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
    return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
  }
  function mascaraCpf(d) {
    d = soDigitos(d).slice(0, 11);
    if (d.length <= 3) return d;
    if (d.length <= 6) return d.slice(0, 3) + '.' + d.slice(3);
    if (d.length <= 9) return d.slice(0, 3) + '.' + d.slice(3, 6) + '.' + d.slice(6);
    return d.slice(0, 3) + '.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-' + d.slice(9);
  }
  function mascaraPlaca(s) {
    const p = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
    // Modelo antigo completo ganha o hífen (ABC-1234); Mercosul fica sem (ABC1D23).
    if (/^[A-Z]{3}[0-9]{4}$/.test(p)) return p.slice(0, 3) + '-' + p.slice(3);
    return p;
  }
  const placaValida = (s) => {
    const p = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return /^[A-Z]{3}[0-9]{4}$/.test(p) || /^[A-Z]{3}[0-9][A-Z][0-9]{2}$/.test(p);
  };
  // Liga a máscara a um input (reaplica a cada tecla).
  function aplicarMascara(input, fn) {
    input.addEventListener('input', () => {
      const v = fn(input.value);
      if (input.value !== v) input.value = v;
    });
  }

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
        toast(n.mensagem, 'notif', n.titulo, () => { location.hash = '#/chamado/' + n.chamadoId; });
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
      ['#/chamados', 'Chamados'],
      ['#/novo', 'Novo chamado'],
      ['#/historico', 'Histórico'],
    ];
    if (ehFinanceiro()) links.push(['#/relatorios', 'Relatórios']);
    if (ehFinanceiro()) links.push(['#/notificacoes', 'Notificações']);
    if (ehFinanceiro()) links.push(['#/auditoria', 'Auditoria']);
    if (ehAdmin()) links.push(['#/usuarios', 'Usuários']);
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
      if (rota === '/historico') return await renderHistorico(cont);
      if (rota === '/relatorios' && ehFinanceiro()) return await renderRelatorios(cont);
      if (rota === '/notificacoes' && ehFinanceiro()) return await renderNotificacoes(cont);
      if (rota === '/auditoria' && ehFinanceiro()) return await renderAuditoria(cont);
      if (rota === '/usuarios' && ehAdmin()) return await renderUsuarios(cont);
      const m = rota.match(/^\/chamado\/(.+)$/);
      if (m) return await renderDetalhe(cont, decodeURIComponent(m[1]));
      return await renderLista(cont);
    } catch (e) {
      cont.innerHTML = '';
      cont.append(el('div', { class: 'cartao' }, el('p', { class: 'erro' }, e.message)));
    }
  }

  // -------------------------------------------- tabela de chamados (comum)
  function tabelaChamados(lista) {
    const tabela = el('table', { class: 'lista' },
      el('thead', null, el('tr', null,
        ...['Nº', 'Tipo', 'Solicitante', 'Veículo / Compra', 'Rota', 'Data da viagem', 'Valor total', 'Status', 'Aberto em']
          .map((h) => el('th', null, h)))));
    const tbody = el('tbody');
    for (const c of lista) {
      tbody.append(el('tr', { onclick: () => { location.hash = '#/chamado/' + c.id; } },
        el('td', null, el('strong', null, c.id)),
        el('td', null, chipTipo(c.tipo)),
        el('td', null, c.solicitante.nome),
        el('td', null, resumoChamado(c)),
        el('td', null, c.tipo === 'compra' ? '—' : (c.rota || '—')),
        el('td', null, c.tipo === 'compra' ? '—' : fmtDataViagem(c.dataViagem)),
        el('td', null, fmtMoeda(c.valorTotalCent)),
        el('td', null, chipStatus(c.status)),
        el('td', { class: 'mudo' }, fmtData(c.criadoEm))));
    }
    tabela.append(tbody);
    return tabela;
  }

  function filtrarChamados(lista, busca, status) {
    let r = lista;
    if (status) r = r.filter((c) => c.status === status);
    const b = String(busca || '').trim().toLowerCase();
    if (b) {
      r = r.filter((c) => [
        c.id,
        c.solicitante.nome,
        c.rota || '',
        c.veiculo ? c.veiculo.placa : '',
        c.veiculo ? c.veiculo.modelo : '',
        c.condutor ? c.condutor.nome : '',
        c.compra ? c.compra.descricao : '',
        c.compra ? c.compra.fornecedor : '',
      ].join(' ').toLowerCase().includes(b));
    }
    return r;
  }

  // ------------------------------------------------------------------ lista
  async function renderLista(cont) {
    const r = await api('GET', '/api/chamados');
    state.chamados = r.chamados;
    cont.innerHTML = '';

    const filtros = el('div', { class: 'filtros' },
      el('input', {
        type: 'search', placeholder: 'Buscar por nº, placa, condutor, rota, compra…',
        value: state.filtroBusca,
        oninput: (e) => { state.filtroBusca = e.target.value; desenhar(); },
      }),
      (() => {
        const s = el('select', {
          onchange: (e) => { state.filtroStatus = e.target.value; desenhar(); },
        }, el('option', { value: '' }, 'Todos os status em andamento'));
        for (const v of STATUS_ATIVOS) {
          const o = el('option', { value: v }, STATUS_LABEL[v]);
          if (state.filtroStatus === v) o.selected = true;
          s.append(o);
        }
        return s;
      })()
    );

    const envolta = el('div', { class: 'tabela-envolta' });
    const cartao = el('div', { class: 'cartao' },
      el('div', { class: 'linha-topo' },
        el('h2', null, 'Chamados em andamento'),
        el('a', { href: '#/novo' }, el('button', { class: 'btn btn-primario' }, 'Novo chamado'))),
      el('p', { class: 'mudo' }, 'Chamados finalizados e cancelados ficam na aba Histórico.'),
      filtros, envolta);
    cont.append(cartao);

    function desenhar() {
      const ativos = state.chamados.filter((c) => STATUS_ATIVOS.includes(c.status));
      const lista = filtrarChamados(ativos, state.filtroBusca, state.filtroStatus);
      envolta.innerHTML = '';
      if (!lista.length) {
        envolta.append(el('div', { class: 'vazio' }, 'Nenhum chamado em andamento. Clique em "Novo chamado" para abrir o primeiro.'));
        return;
      }
      envolta.append(tabelaChamados(lista));
    }
    desenhar();
  }

  // ------------------------------------------------------------------ histórico (aba)
  async function renderHistorico(cont) {
    const r = await api('GET', '/api/chamados');
    state.chamados = r.chamados;
    cont.innerHTML = '';

    const filtros = el('div', { class: 'filtros' },
      el('input', {
        type: 'search', placeholder: 'Buscar no histórico…',
        value: state.filtroBuscaHist,
        oninput: (e) => { state.filtroBuscaHist = e.target.value; desenhar(); },
      }),
      (() => {
        const s = el('select', {
          onchange: (e) => { state.filtroStatusHist = e.target.value; desenhar(); },
        }, el('option', { value: '' }, 'Finalizados e cancelados'));
        for (const v of STATUS_HISTORICO) {
          const o = el('option', { value: v }, STATUS_LABEL[v]);
          if (state.filtroStatusHist === v) o.selected = true;
          s.append(o);
        }
        return s;
      })()
    );

    const envolta = el('div', { class: 'tabela-envolta' });
    cont.append(el('div', { class: 'cartao' },
      el('div', { class: 'linha-topo' }, el('h2', null, 'Histórico de chamados')),
      el('p', { class: 'mudo' }, 'Todos os chamados já finalizados ou cancelados.'),
      filtros, envolta));

    function desenhar() {
      const encerrados = state.chamados.filter((c) => STATUS_HISTORICO.includes(c.status));
      const lista = filtrarChamados(encerrados, state.filtroBuscaHist, state.filtroStatusHist);
      envolta.innerHTML = '';
      if (!lista.length) {
        envolta.append(el('div', { class: 'vazio' }, 'Nenhum chamado finalizado ou cancelado ainda.'));
        return;
      }
      envolta.append(tabelaChamados(lista));
    }
    desenhar();
  }

  // ------------------------------------------------------------------ relatórios (financeiro/admin)
  async function renderRelatorios(cont) {
    const r = await api('GET', '/api/relatorios/movimento');
    cont.innerHTML = '';
    const itens = r.itens || [];

    const pad = (n) => String(n).padStart(2, '0');
    const isoLocal = (dt) => dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
    const hojeIso = isoLocal(new Date());
    const lim7Iso = isoLocal(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    // Data de referência: compra conta no dia da abertura; viagem, na data da
    // viagem (viagens agendadas para depois de hoje são as "futuras").
    const dataRef = (c) => (c.tipo === 'compra' || !c.dataViagem) ? isoLocal(new Date(c.criadoEm)) : c.dataViagem;
    const ehFuturo = (c) => dataRef(c) > hojeIso;
    const soma = (l) => l.filter((c) => c.status !== 'cancelado').reduce((s, c) => s + c.valorTotalCent, 0);

    const viagens = itens.filter((c) => c.tipo !== 'compra');
    const compras = itens.filter((c) => c.tipo === 'compra');
    const doDia = itens.filter((c) => dataRef(c) === hojeIso);
    const futuras = itens.filter(ehFuturo);
    const futuras7 = futuras.filter((c) => dataRef(c) <= lim7Iso);
    const somaFuturo7 = soma(futuras7);
    const somaFuturoTotal = soma(futuras);

    const cardResumo = (rotulo, valor, obs, destaque) =>
      el('div', { class: 'valor-cartao' + (destaque ? ' destaque' : '') },
        el('div', { class: 'rotulo' }, rotulo),
        el('div', { class: 'valor' }, valor),
        obs ? el('div', { class: 'obs' }, obs) : null);

    const resumo = el('div', { class: 'valores' },
      cardResumo('Valor do dia (' + fmtDataViagem(hojeIso) + ')', fmtMoeda(soma(doDia)),
        'Compras de hoje + viagens com data de hoje.', true),
      cardResumo('Valor futuro — próximos 7 dias', fmtMoeda(somaFuturo7),
        somaFuturoTotal > somaFuturo7
          ? 'Futuro total (todas as datas): ' + fmtMoeda(somaFuturoTotal)
          : (futuras.length ? futuras.length + ' viagem(ns) futura(s) agendada(s).' : 'Nenhuma viagem futura agendada.'), true),
      cardResumo('Total geral — viagens', fmtMoeda(soma(viagens)), viagens.length + ' chamado(s) de viagem.'),
      cardResumo('Total geral — compras', fmtMoeda(soma(compras)), compras.length + ' compra(s).'));

    const cartao = el('div', { class: 'cartao' },
      el('div', { class: 'linha-topo' }, el('h2', null, 'Relatórios')),
      el('p', { class: 'mudo' },
        'Compras contam no dia da abertura; viagens contam na data da viagem — as agendadas para depois de hoje aparecem como futuras. Chamados cancelados aparecem nas listas, mas não somam nos totais.'),
      resumo);
    cont.append(cartao);

    if (!itens.length) {
      cartao.append(el('div', { class: 'vazio' }, 'Nenhum chamado registrado ainda.'));
      return;
    }

    // ---- sub-abas: combinada por dia · só viagens · só compras ----
    const barra = el('div', { class: 'abas' });
    const corpo = el('div');
    for (const [k, rot] of [['dia', 'Por dia (viagens + compras)'], ['viagens', 'Viagens'], ['compras', 'Compras']]) {
      barra.append(el('button', {
        class: 'aba' + (state.abaRelatorio === k ? ' ativa' : ''),
        onclick: () => { state.abaRelatorio = k; renderRota(); },
      }, rot));
    }
    cartao.append(barra, corpo);

    const chipFutura = () => el('span', { class: 'chip chip-futuro' }, 'Futura');

    const linhaItem = (c, cols) => {
      const tr = el('tr', { onclick: () => { location.hash = '#/chamado/' + c.id; } });
      for (const col of cols) tr.append(el('td', null, col));
      return tr;
    };
    const montarTabela = (cabecalhos, linhas) => {
      const t = el('table', { class: 'lista' },
        el('thead', null, el('tr', null, ...cabecalhos.map((h) => el('th', null, h)))));
      const tb = el('tbody');
      for (const l of linhas) tb.append(l);
      t.append(tb);
      return el('div', { class: 'tabela-envolta' }, t);
    };

    if (state.abaRelatorio === 'viagens') {
      // ---- lista só de viagens (futuras primeiro, marcadas) ----
      const lista = viagens.slice().sort((a, b) => (dataRef(a) < dataRef(b) ? 1 : -1));
      corpo.append(el('div', { class: 'relatorio-dia-topo' },
        el('h3', null, 'Viagens'),
        el('div', { class: 'relatorio-total' }, 'Total: ' + fmtMoeda(soma(viagens)))));
      if (!lista.length) { corpo.append(el('div', { class: 'vazio' }, 'Nenhuma viagem registrada.')); return; }
      corpo.append(montarTabela(
        ['Nº', 'Data da viagem', 'Rota', 'Solicitante', 'Veículo', 'Condutor', 'Valor', 'Status'],
        lista.map((c) => linhaItem(c, [
          el('strong', null, c.id),
          el('span', null, fmtDataViagem(c.dataViagem), ehFuturo(c) ? ' ' : '', ehFuturo(c) ? chipFutura() : ''),
          c.rota || '—',
          c.solicitante,
          c.descricao,
          c.condutor || '—',
          fmtMoeda(c.valorTotalCent),
          chipStatus(c.status),
        ]))));
      return;
    }

    if (state.abaRelatorio === 'compras') {
      // ---- lista só de compras ----
      corpo.append(el('div', { class: 'relatorio-dia-topo' },
        el('h3', null, 'Compras'),
        el('div', { class: 'relatorio-total' }, 'Total: ' + fmtMoeda(soma(compras)))));
      if (!compras.length) { corpo.append(el('div', { class: 'vazio' }, 'Nenhuma compra registrada.')); return; }
      corpo.append(montarTabela(
        ['Nº', 'Aberto em', 'Solicitante', 'Descrição', 'Fornecedor', 'Valor', 'Status'],
        compras.map((c) => linhaItem(c, [
          el('strong', null, c.id),
          fmtData(c.criadoEm),
          c.solicitante,
          c.descricao,
          c.fornecedor || '—',
          fmtMoeda(c.valorTotalCent),
          chipStatus(c.status),
        ]))));
      return;
    }

    // ---- combinada: viagens + compras agrupadas por dia (futuros primeiro) ----
    const grupos = new Map();
    for (const c of itens) {
      const dia = dataRef(c);
      if (!grupos.has(dia)) grupos.set(dia, []);
      grupos.get(dia).push(c);
    }
    const dias = [...grupos.keys()].sort().reverse();
    for (const dia of dias) {
      const doGrupo = grupos.get(dia);
      const somaViagensDia = soma(doGrupo.filter((c) => c.tipo !== 'compra'));
      const somaComprasDia = soma(doGrupo.filter((c) => c.tipo === 'compra'));
      const titulo = el('h3', null, fmtDataViagem(dia),
        dia === hojeIso ? el('span', { class: 'mudo' }, ' — hoje') : '',
        dia > hojeIso ? ' ' : '', dia > hojeIso ? chipFutura() : '');
      corpo.append(el('div', { class: 'relatorio-dia' },
        el('div', { class: 'relatorio-dia-topo' },
          titulo,
          el('div', { class: 'relatorio-detalhe' },
            (somaViagensDia && somaComprasDia)
              ? el('span', { class: 'mudo' }, 'Viagens ' + fmtMoeda(somaViagensDia) + ' · Compras ' + fmtMoeda(somaComprasDia) + '  ')
              : '',
            el('span', { class: 'relatorio-total' }, 'Total do dia: ' + fmtMoeda(somaViagensDia + somaComprasDia)))),
        montarTabela(
          ['Nº', 'Tipo', 'Solicitante', 'Descrição', 'Rota / Fornecedor', 'Valor', 'Status'],
          doGrupo.map((c) => linhaItem(c, [
            el('strong', null, c.id),
            chipTipo(c.tipo),
            c.solicitante,
            c.descricao,
            (c.tipo === 'compra' ? c.fornecedor : c.rota) || '—',
            fmtMoeda(c.valorTotalCent),
            chipStatus(c.status),
          ])))));
    }
  }

  // ------------------------------------------------------------------ novo chamado
  function renderNovo(cont) {
    cont.innerHTML = '';
    let tipo = 'viagem';

    // ---- valor + prévia 70/30 (só para viagem) ----
    const previa = el('div', { class: 'previa-valores oculto' });
    const inputValor = el('input', { type: 'text', inputmode: 'decimal', placeholder: 'Ex.: 1.500,00', required: '' });
    const atualizarPrevia = () => {
      const cent = parseMoeda(inputValor.value);
      if (!cent || tipo === 'compra') { previa.classList.add('oculto'); return; }
      const adiant = Math.round(cent * 0.7);
      previa.classList.remove('oculto');
      previa.innerHTML =
        '<div><div class="rotulo">Adiantamento (70%)</div><div class="num">' + esc(fmtMoeda(adiant)) + '</div></div>' +
        '<div><div class="rotulo">Saldo (30%)</div><div class="num">' + esc(fmtMoeda(cent - adiant)) + '</div></div>' +
        '<div><div class="rotulo">Valor total</div><div class="num">' + esc(fmtMoeda(cent)) + '</div></div>';
    };
    inputValor.addEventListener('input', atualizarPrevia);

    const campo = (rotulo, attrs) => {
      const i = el('input', Object.assign({ type: 'text' }, attrs || {}));
      return { rotulo: el('label', null, rotulo, i), input: i };
    };

    // ---- campos de viagem ----
    const placa = campo('Placa (BR ou Mercosul) *', { placeholder: 'ABC-1234 ou ABC1D23', maxlength: '8' });
    aplicarMascara(placa.input, mascaraPlaca);
    const modelo = campo('Marca / modelo *', { placeholder: 'Ex.: VW Constellation 24.280' });
    const ano = campo('Ano', { placeholder: 'Ex.: 2020', inputmode: 'numeric', maxlength: '4' });
    aplicarMascara(ano.input, (v) => soDigitos(v).slice(0, 4));
    const km = campo('KM atual', { placeholder: 'Ex.: 154000', inputmode: 'numeric' });
    aplicarMascara(km.input, (v) => soDigitos(v).slice(0, 9));
    const dataViagem = campo('Data da viagem *', { type: 'date' });
    const rotaViagem = campo('Rota da viagem', { placeholder: 'Ex.: São Paulo → Curitiba (BR-116)' });
    const cNome = campo('Nome do condutor *', {});
    const cDoc = campo('CPF (só números)', { placeholder: '000.000.000-00', inputmode: 'numeric', maxlength: '14' });
    aplicarMascara(cDoc.input, mascaraCpf);
    const cCnh = campo('CNH (só números)', { placeholder: '11 números da CNH', inputmode: 'numeric', maxlength: '11' });
    aplicarMascara(cCnh.input, (v) => soDigitos(v).slice(0, 11));
    const cTel = campo('Telefone', { placeholder: '(00) 90000-0000', inputmode: 'numeric', maxlength: '15' });
    aplicarMascara(cTel.input, mascaraTelefone);

    // ---- campos de compra ----
    const compraDesc = campo('O que será comprado? *', { placeholder: 'Ex.: 4 pneus 295/80 R22.5' });
    const compraForn = campo('Fornecedor', { placeholder: 'Ex.: Pneus Brasil Ltda.' });

    const obs = el('textarea', { rows: '3', placeholder: 'Motivo, detalhes, observações…' });

    const secViagemVeiculo = el('div', null,
      el('h3', { class: 'form-secao' }, 'Dados do veículo'),
      el('div', { class: 'form-grade' }, placa.rotulo, modelo.rotulo, ano.rotulo, km.rotulo),
      el('h3', { class: 'form-secao' }, 'Viagem'),
      el('div', { class: 'form-grade' }, dataViagem.rotulo, rotaViagem.rotulo),
      el('h3', { class: 'form-secao' }, 'Dados do condutor'),
      el('div', { class: 'form-grade' }, cNome.rotulo, cDoc.rotulo, cCnh.rotulo, cTel.rotulo));

    const secCompra = el('div', { class: 'oculto' },
      el('h3', { class: 'form-secao' }, 'Dados da compra'),
      el('div', { class: 'form-grade' }, compraDesc.rotulo, compraForn.rotulo));

    const rotuloValor = el('label', null, 'Valor total (R$) *', inputValor);
    const dicaValor = el('p', { class: 'mudo' },
      'O sistema calcula automaticamente o adiantamento de 70% e o saldo de 30%.');

    // ---- seletor de tipo ----
    const btnViagem = el('button', { type: 'button', class: 'tipo-btn ativo' }, 'Adiantamento de viagem');
    const btnCompra = el('button', { type: 'button', class: 'tipo-btn' }, 'Compra');
    function definirTipo(novo) {
      tipo = novo;
      btnViagem.classList.toggle('ativo', tipo === 'viagem');
      btnCompra.classList.toggle('ativo', tipo === 'compra');
      secViagemVeiculo.classList.toggle('oculto', tipo !== 'viagem');
      secCompra.classList.toggle('oculto', tipo !== 'compra');
      dicaValor.textContent = tipo === 'viagem'
        ? 'O sistema calcula automaticamente o adiantamento de 70% e o saldo de 30%.'
        : 'Compra é paga em parcela única pelo financeiro (sem 70/30).';
      atualizarPrevia();
    }
    btnViagem.addEventListener('click', () => definirTipo('viagem'));
    btnCompra.addEventListener('click', () => definirTipo('compra'));

    const btn = el('button', { class: 'btn btn-primario', type: 'submit' }, 'Abrir chamado');
    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const valorTotalCent = parseMoeda(inputValor.value);
        if (!valorTotalCent) { toast('Informe um valor total válido.', 'erro'); return; }

        const corpo = { tipo, valorTotalCent, observacoes: obs.value };
        if (tipo === 'viagem') {
          if (!placaValida(placa.input.value)) { toast('Placa inválida. Use ABC-1234 (antiga) ou ABC1D23 (Mercosul).', 'erro'); placa.input.focus(); return; }
          if (!modelo.input.value.trim()) { toast('Informe o modelo do veículo.', 'erro'); modelo.input.focus(); return; }
          if (!dataViagem.input.value) { toast('Informe a data da viagem.', 'erro'); dataViagem.input.focus(); return; }
          if (!cNome.input.value.trim()) { toast('Informe o nome do condutor.', 'erro'); cNome.input.focus(); return; }
          const telD = soDigitos(cTel.input.value);
          if (telD && telD.length !== 10 && telD.length !== 11) { toast('Telefone incompleto. Use DDD + número.', 'erro'); cTel.input.focus(); return; }
          const cpfD = soDigitos(cDoc.input.value);
          if (cpfD && cpfD.length !== 11) { toast('CPF incompleto: são 11 números.', 'erro'); cDoc.input.focus(); return; }
          const cnhD = soDigitos(cCnh.input.value);
          if (cnhD && cnhD.length !== 11) { toast('CNH incompleta: são 11 números.', 'erro'); cCnh.input.focus(); return; }
          corpo.veiculo = { placa: placa.input.value, modelo: modelo.input.value, ano: ano.input.value, km: km.input.value };
          corpo.condutor = { nome: cNome.input.value, documento: cDoc.input.value, cnh: cCnh.input.value, telefone: cTel.input.value };
          corpo.dataViagem = dataViagem.input.value;
          corpo.rota = rotaViagem.input.value;
        } else {
          if (!compraDesc.input.value.trim()) { toast('Descreva o que será comprado.', 'erro'); compraDesc.input.focus(); return; }
          corpo.compra = { descricao: compraDesc.input.value, fornecedor: compraForn.input.value };
        }

        btn.disabled = true;
        try {
          const r = await api('POST', '/api/chamados', corpo);
          toast('Chamado ' + r.chamado.id + ' aberto. O financeiro foi notificado.', null, 'Chamado criado');
          state.abaDetalhe = 'financeiro';
          location.hash = '#/chamado/' + r.chamado.id;
        } catch (err) {
          toast(err.message, 'erro');
        } finally {
          btn.disabled = false;
        }
      },
    },
      el('h3', { class: 'form-secao' }, 'Tipo de chamado'),
      el('div', { class: 'tipo-escolha' }, btnViagem, btnCompra),
      secViagemVeiculo,
      secCompra,
      el('h3', { class: 'form-secao' }, 'Valor do chamado'),
      dicaValor,
      el('div', { class: 'form-grade' }, rotuloValor),
      previa,
      el('h3', { class: 'form-secao' }, 'Observações'),
      obs,
      el('div', { class: 'acoes-status' }, btn,
        el('button', { class: 'btn btn-suave', type: 'button', onclick: () => { location.hash = '#/chamados'; } }, 'Cancelar')));

    cont.append(el('div', { class: 'cartao' },
      el('div', { class: 'linha-topo' }, el('h2', null, 'Novo chamado')),
      el('p', { class: 'mudo' }, 'Escolha o tipo do chamado: adiantamento de viagem (70/30) ou compra (pagamento único).'),
      form));
  }

  // ------------------------------------------------------------------ detalhe
  async function renderDetalhe(cont, id) {
    const r = await api('GET', '/api/chamados/' + encodeURIComponent(id));
    const c = r.chamado;
    cont.innerHTML = '';

    const abas = c.tipo === 'compra' ? [
      ['financeiro', 'Pagamento'],
      ['dados', 'Dados'],
      ['historico', 'Histórico'],
    ] : [
      ['financeiro', 'Adiantamento e saldo'],
      ['anexos', 'Anexos da viagem'],
      ['dados', 'Dados'],
      ['historico', 'Histórico'],
    ];
    if (!abas.some(([k]) => k === state.abaDetalhe)) state.abaDetalhe = 'financeiro';
    const corpoAba = el('div');
    const barraAbas = el('div', { class: 'abas' });
    for (const [chave, rotulo] of abas) {
      const b = el('button', { class: 'aba' + (state.abaDetalhe === chave ? ' ativa' : ''), onclick: () => { state.abaDetalhe = chave; renderRota(); } }, rotulo);
      barraAbas.append(b);
    }

    const subtitulo = c.tipo === 'compra'
      ? 'Solicitante: ' + c.solicitante.nome + (c.compra && c.compra.fornecedor ? ' · Fornecedor: ' + c.compra.fornecedor : '') + ' · Aberto em ' + fmtData(c.criadoEm)
      : 'Solicitante: ' + c.solicitante.nome + ' · Condutor: ' + c.condutor.nome +
        ' · Viagem: ' + fmtDataViagem(c.dataViagem) + (c.rota ? ' · Rota: ' + c.rota : '') +
        ' · Aberto em ' + fmtData(c.criadoEm);

    cont.append(el('div', { class: 'cartao' },
      el('div', { class: 'linha-topo' },
        el('h2', null, c.id + ' — ' + (c.tipo === 'compra' ? (c.compra ? c.compra.descricao : 'Compra') : c.veiculo.placa)),
        el('div', null, chipTipo(c.tipo), ' ', chipStatus(c.status))),
      el('p', { class: 'mudo' }, subtitulo),
      barraAbas, corpoAba));

    if (state.abaDetalhe === 'anexos' && c.tipo !== 'compra') renderAbaAnexos(corpoAba, c);
    else if (state.abaDetalhe === 'dados') renderAbaDados(corpoAba, c);
    else if (state.abaDetalhe === 'historico') renderAbaHistorico(corpoAba, c);
    else if (c.tipo === 'compra') renderAbaPagamentoCompra(corpoAba, c);
    else renderAbaFinanceiro(corpoAba, c);
  }

  function cartaoValor(rotulo, cent, statusChip, obs, destaque) {
    return el('div', { class: 'valor-cartao' + (destaque ? ' destaque' : '') },
      el('div', { class: 'rotulo' }, rotulo),
      el('div', { class: 'valor' }, fmtMoeda(cent)),
      statusChip ? el('div', null, statusChip) : null,
      obs ? el('div', { class: 'obs' }, obs) : null);
  }

  async function acaoChamado(caminho, msg) {
    try {
      await api('POST', caminho, {});
      toast(msg);
      renderRota();
    } catch (e) { toast(e.message, 'erro'); }
  }

  function renderAbaPagamentoCompra(corpo, c) {
    corpo.append(el('div', { class: 'valores' },
      cartaoValor('Valor da compra', c.valorTotalCent,
        c.compraPagaEm ? el('span', { class: 'chip chip-pago' }, 'Pago em ' + fmtData(c.compraPagaEm))
          : el('span', { class: 'chip chip-pendente' }, 'Pendente'),
        'Pagamento único registrado pelo financeiro.', true)));

    const acoes = el('div', { class: 'acoes-status' });
    if (ehFinanceiro() && !c.compraPagaEm && c.status !== 'cancelado') {
      acoes.append(el('button', {
        class: 'btn btn-verde',
        onclick: () => acaoChamado('/api/chamados/' + c.id + '/compra-paga', 'Compra registrada como paga. Chamado finalizado.'),
      }, 'Marcar compra como paga'));
    }
    if (ehAdmin() && c.status !== 'finalizado' && c.status !== 'cancelado') {
      acoes.append(el('button', {
        class: 'btn btn-perigo',
        onclick: () => { if (confirm('Cancelar este chamado?')) acaoChamado('/api/chamados/' + c.id + '/cancelar', 'Chamado cancelado.'); },
      }, 'Cancelar chamado'));
    }
    if (acoes.children.length) corpo.append(acoes);
  }

  function renderAbaFinanceiro(corpo, c) {
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
        onclick: () => acaoChamado('/api/chamados/' + c.id + '/adiantamento-pago', 'Adiantamento registrado como pago.'),
      }, 'Marcar adiantamento como pago'));
    }
    if (!c.encerramentoConfirmadoEm && c.status !== 'cancelado') {
      acoes.append(el('button', {
        class: 'btn btn-primario',
        onclick: () => {
          if (confirm('Confirmar o encerramento da viagem? O lembrete de pagamento do saldo será agendado para daqui a 5 dias.')) {
            acaoChamado('/api/chamados/' + c.id + '/encerrar-viagem', 'Encerramento confirmado. Lembrete do saldo agendado (5 dias).');
          }
        },
      }, 'Confirmar encerramento da viagem'));
    }
    if (ehFinanceiro() && c.encerramentoConfirmadoEm && !c.saldoPagoEm && c.status !== 'cancelado') {
      acoes.append(el('button', {
        class: 'btn btn-verde',
        onclick: () => acaoChamado('/api/chamados/' + c.id + '/saldo-pago', 'Saldo pago. Chamado finalizado.'),
      }, 'Marcar saldo como pago'));
    }
    if (ehAdmin() && c.status !== 'finalizado' && c.status !== 'cancelado') {
      acoes.append(el('button', {
        class: 'btn btn-perigo',
        onclick: () => { if (confirm('Cancelar este chamado?')) acaoChamado('/api/chamados/' + c.id + '/cancelar', 'Chamado cancelado.'); },
      }, 'Cancelar chamado'));
    }
    if (acoes.children.length) corpo.append(acoes);

    if (c.encerramentoConfirmadoEm && !c.saldoPagoEm) {
      const quando = new Date(Date.parse(c.encerramentoConfirmadoEm) + 5 * 24 * 60 * 60 * 1000);
      corpo.append(el('div', { class: 'aviso-lembrete' },
        c.lembreteSaldoEm
          ? 'Lembrete de pagamento do saldo já enviado ao financeiro em ' + fmtData(c.lembreteSaldoEm) + '.'
          : 'Viagem encerrada em ' + fmtData(c.encerramentoConfirmadoEm) +
            '. O financeiro receberá o lembrete de pagamento do saldo em ' + quando.toLocaleDateString('pt-BR') + ' (5 dias após o encerramento).'));
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
          el('button', { class: 'btn btn-suave', onclick: () => inputArquivo.click() }, 'Anexar foto de ' + (tipo === 'entrada' ? 'entrada' : 'saída')),
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
          }, '×'));
        }
        minis.append(mini);
      }
      g.append(minis);
      return g;
    };
    corpo.append(el('div', { class: 'anexos-grupos' },
      grupo('entrada', 'Entrada da viagem', 'Fotos do veículo/odômetro na SAÍDA da base (início da viagem).'),
      grupo('saida', 'Saída da viagem', 'Fotos do veículo/odômetro no RETORNO (fim da viagem).')));
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
    if (c.tipo === 'compra') {
      corpo.append(el('div', { class: 'dados-grade' },
        bloco('Compra', [
          ['Descrição', c.compra ? c.compra.descricao : ''],
          ['Fornecedor', c.compra ? c.compra.fornecedor : ''],
          ['Valor', fmtMoeda(c.valorTotalCent)],
          ['Pagamento', c.compraPagaEm ? 'Pago em ' + fmtData(c.compraPagaEm) : 'Pendente'],
        ]),
        bloco('Chamado', [
          ['Solicitante', c.solicitante.nome],
          ['Aberto em', fmtData(c.criadoEm)],
          ['Status', STATUS_LABEL[c.status]],
          ['Observações', c.observacoes],
        ])));
      return;
    }
    corpo.append(el('div', { class: 'dados-grade' },
      bloco('Veículo', [
        ['Placa', c.veiculo.placa], ['Marca / modelo', c.veiculo.modelo],
        ['Ano', c.veiculo.ano], ['KM na abertura', c.veiculo.km],
      ]),
      bloco('Condutor', [
        ['Nome', c.condutor.nome], ['CPF', c.condutor.documento],
        ['CNH', c.condutor.cnh], ['Telefone', c.condutor.telefone],
      ]),
      bloco('Viagem', [
        ['Data da viagem', fmtDataViagem(c.dataViagem)],
        ['Rota', c.rota],
        ['Encerramento', c.encerramentoConfirmadoEm ? fmtData(c.encerramentoConfirmadoEm) : 'Ainda não confirmado'],
      ]),
      bloco('Chamado', [
        ['Solicitante', c.solicitante.nome],
        ['Aberto em', fmtData(c.criadoEm)],
        ['Status', STATUS_LABEL[c.status]],
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
        el('span', { class: 'mudo' }, 'Cada aviso aparece uma vez na barra de tarefas; marque como visto para limpar o sino.')));
    if (!r.notificacoes.length) cartao.append(el('div', { class: 'vazio' }, 'Nenhuma notificação por enquanto.'));
    for (const n of r.notificacoes) {
      const pendente = !n.reconhecidaPor;
      const item = el('div', { class: 'notif ' + (pendente ? 'pendente' : 'ok') },
        el('div', { class: 'titulo' }, n.titulo),
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
          }, 'Marcar como visto') : null));
      cartao.append(item);
    }
    cont.append(cartao);
  }

  // ------------------------------------------------------------------ auditoria (financeiro/admin)
  async function renderAuditoria(cont) {
    const r = await api('GET', '/api/auditoria');
    cont.innerHTML = '';
    const eventos = r.eventos || [];

    const quemFez = (e) => {
      if (e.usuario) return e.usuario.nome + ' (' + e.usuario.papel + ')';
      return /recusad/i.test(e.acao) ? 'Não autenticado' : 'Sistema';
    };

    const busca = el('input', {
      type: 'search', placeholder: 'Buscar por usuário, ação, chamado…',
      value: state.filtroBuscaAud,
      oninput: (ev) => { state.filtroBuscaAud = ev.target.value; desenhar(); },
    });
    const envolta = el('div', { class: 'tabela-envolta' });
    cont.append(el('div', { class: 'cartao' },
      el('div', { class: 'linha-topo' }, el('h2', null, 'Auditoria')),
      el('p', { class: 'mudo' },
        'Trilha de todos os acessos e alterações no sistema: logins (inclusive recusados), abertura de chamados, pagamentos, encerramentos, cancelamentos, anexos, notificações vistas e gestão de usuários — com usuário, data e hora. Visível apenas para o financeiro. Últimos ' + eventos.length + ' registros.'),
      el('div', { class: 'filtros' }, busca),
      envolta));

    function desenhar() {
      const b = state.filtroBuscaAud.trim().toLowerCase();
      let lista = eventos;
      if (b) {
        lista = lista.filter((e) =>
          [e.id, e.acao, e.detalhe || '', quemFez(e), e.ip || '', fmtData(e.em)]
            .join(' ').toLowerCase().includes(b));
      }
      envolta.innerHTML = '';
      if (!lista.length) {
        envolta.append(el('div', { class: 'vazio' }, 'Nenhum registro de auditoria encontrado.'));
        return;
      }
      const tabela = el('table', { class: 'lista' },
        el('thead', null, el('tr', null,
          ...['Data e hora', 'Usuário', 'Ação', 'Detalhe', 'IP'].map((h) => el('th', null, h)))));
      const tbody = el('tbody');
      for (const e of lista) {
        tbody.append(el('tr', { style: 'cursor:default' },
          el('td', { class: 'mudo' }, fmtData(e.em)),
          el('td', null, el('strong', null, quemFez(e))),
          el('td', null, e.acao),
          el('td', { class: 'aud-detalhe' }, e.detalhe || '—'),
          el('td', { class: 'mudo' }, e.ip || '—')));
      }
      tabela.append(tbody);
      envolta.append(tabela);
    }
    desenhar();
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
      el('div', { class: 'acoes-status' }, el('button', { class: 'btn btn-primario', type: 'submit' }, 'Criar usuário')));

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
      el('h3', { class: 'form-secao' }, 'Novo usuário'), form,
      el('h3', { class: 'form-secao' }, 'Usuários cadastrados'), envolta));
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
