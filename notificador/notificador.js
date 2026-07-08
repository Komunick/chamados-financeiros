'use strict';
/*
 * Notificador Brazil Transports — roda na máquina de quem RECEBE os chamados
 * (financeiro) e mostra na barra de tarefas do Windows APENAS as notificações
 * NOVAS: cada aviso aparece uma única vez (balão + central de notificações),
 * sem repetição. O que já foi avisado fica registrado em avisadas.json, então
 * reiniciar o notificador não reexibe avisos antigos.
 *
 * Node puro, sem dependências. O balão é exibido via PowerShell
 * (Windows.UI.Notifications, nativo do Windows 10/11).
 *
 * Configuração: config.json ao lado deste arquivo:
 *   {
 *     "servidor": "http://10.13.47.131:8090",
 *     "login": "usuario-financeiro",
 *     "senha": "senha",
 *     "intervaloSegundos": 30    // frequência de consulta ao servidor
 *   }
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const DIR = __dirname;
const CONFIG_FILE = path.join(DIR, 'config.json');
const LOG_FILE = path.join(DIR, 'notificador.log');
const PS1_FILE = path.join(DIR, 'toast-tmp.ps1');
const AVISADAS_FILE = path.join(DIR, 'avisadas.json'); // ids já exibidos (não repetir)

function log(msg) {
  const linha = new Date().toLocaleString('pt-BR') + '  ' + msg;
  console.log(linha);
  try {
    // Mantém o log pequeno.
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 512 * 1024) {
      fs.writeFileSync(LOG_FILE, '');
    }
    fs.appendFileSync(LOG_FILE, linha + '\r\n');
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Configuração.
// ---------------------------------------------------------------------------
if (!fs.existsSync(CONFIG_FILE)) {
  const exemplo = {
    servidor: 'http://10.13.47.131:8090',
    login: 'financeiro',
    senha: 'TROQUE-AQUI',
    intervaloSegundos: 30,
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(exemplo, null, 2));
  log('config.json criado. Edite o arquivo com o endereço do servidor e o login do financeiro e rode de novo.');
  process.exit(1);
}
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
catch (e) { log('config.json inválido: ' + e.message); process.exit(1); }
if (!cfg.servidor || !cfg.login || !cfg.senha || cfg.senha === 'TROQUE-AQUI') {
  log('Preencha servidor, login e senha no config.json.');
  process.exit(1);
}
const INTERVALO = Math.max(10, parseInt(cfg.intervaloSegundos, 10) || 30) * 1000;
const BASE = String(cfg.servidor).replace(/\/+$/, '');

// ---------------------------------------------------------------------------
// Memória do que já foi avisado (para exibir cada notificação só UMA vez,
// mesmo depois de reiniciar o notificador).
// ---------------------------------------------------------------------------
let avisadas = null; // null = primeira execução (sem arquivo): não reavisar o passado
try {
  avisadas = new Set(JSON.parse(fs.readFileSync(AVISADAS_FILE, 'utf8')));
} catch (e) { /* sem arquivo ainda */ }

function salvarAvisadas() {
  try { fs.writeFileSync(AVISADAS_FILE, JSON.stringify([...avisadas])); }
  catch (e) { log('Falha ao salvar avisadas.json: ' + e.message); }
}

// ---------------------------------------------------------------------------
// HTTP simples (sem dependências).
// ---------------------------------------------------------------------------
function requisicao(metodo, caminho, corpo, token) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(BASE + caminho); } catch (e) { return reject(new Error('URL do servidor inválida: ' + BASE)); }
    const mod = u.protocol === 'https:' ? https : http;
    const dados = corpo ? JSON.stringify(corpo) : null;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: metodo,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { 'X-Token': token } : {},
        dados ? { 'Content-Length': Buffer.byteLength(dados) } : {}
      ),
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { /* ignore */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('tempo esgotado')); });
    req.on('error', reject);
    if (dados) req.write(dados);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Balão na barra de tarefas (toast do Windows via PowerShell).
// ---------------------------------------------------------------------------
function xmlEsc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let toastFila = Promise.resolve();
function mostrarToast(titulo, linha1, linha2) {
  toastFila = toastFila.then(() => new Promise((resolve) => {
    const xml =
      '<toast scenario="reminder" activationType="protocol" launch="' + xmlEsc(BASE) + '/">' +
      '<visual><binding template="ToastGeneric">' +
      '<text>' + xmlEsc(titulo) + '</text>' +
      '<text>' + xmlEsc(linha1) + '</text>' +
      (linha2 ? '<text>' + xmlEsc(linha2) + '</text>' : '') +
      '</binding></visual>' +
      '<actions>' +
      '<action content="Abrir sistema" activationType="protocol" arguments="' + xmlEsc(BASE) + '/"/>' +
      '<action content="Dispensar" activationType="system" arguments="dismiss"/>' +
      '</actions>' +
      '<audio src="ms-winsoundevent:Notification.Default"/>' +
      '</toast>';
    const ps =
      "$ErrorActionPreference = 'Stop'\r\n" +
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null\r\n" +
      "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null\r\n" +
      "$xml = @'\r\n" + xml + "\r\n'@\r\n" +
      "$doc = New-Object Windows.Data.Xml.Dom.XmlDocument\r\n" +
      "$doc.LoadXml($xml)\r\n" +
      "$toast = New-Object Windows.UI.Notifications.ToastNotification($doc)\r\n" +
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(" +
      "'{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)\r\n";
    try { fs.writeFileSync(PS1_FILE, '﻿' + ps, 'utf8'); }
    catch (e) { log('Falha ao preparar o balão: ' + e.message); return resolve(); }
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1_FILE], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errTxt = '';
    p.stderr.on('data', (c) => { errTxt += c; });
    p.on('close', (code) => {
      if (code !== 0) log('Balão falhou (código ' + code + '): ' + errTxt.trim().slice(0, 300));
      setTimeout(resolve, 1200); // pequeno intervalo entre balões
    });
    p.on('error', (e) => { log('PowerShell indisponível: ' + e.message); resolve(); });
  }));
  return toastFila;
}

// ---------------------------------------------------------------------------
// Laço principal.
// ---------------------------------------------------------------------------
let token = '';

async function entrar() {
  const r = await requisicao('POST', '/api/auth/login', { login: cfg.login, senha: cfg.senha });
  if (r.status !== 200 || !r.json.token) {
    throw new Error('login recusado: ' + (r.json.error || 'status ' + r.status));
  }
  token = r.json.token;
  log('Conectado ao servidor como ' + cfg.login + ' (' + (r.json.usuario ? r.json.usuario.papel : '?') + ').');
}

async function verificar() {
  if (!token) await entrar();
  let r = await requisicao('GET', '/api/notificacoes/pendentes', null, token);
  if (r.status === 401) { // sessão caiu → reconecta uma vez
    await entrar();
    r = await requisicao('GET', '/api/notificacoes/pendentes', null, token);
  }
  if (r.status === 403) throw new Error('o usuário do config.json precisa ter papel "financeiro" (ou admin).');
  if (r.status !== 200) throw new Error('servidor respondeu ' + r.status + ': ' + (r.json.error || ''));

  const pendentes = r.json.notificacoes || [];

  // Primeira execução (sem avisadas.json): registra o que já existia sem
  // exibir balão — só as notificações NOVAS a partir de agora geram aviso.
  if (avisadas === null) {
    avisadas = new Set(pendentes.map((n) => n.id));
    salvarAvisadas();
    log('Primeira execução: ' + pendentes.length + ' notificação(ões) antiga(s) registrada(s) sem aviso. Só as novas serão exibidas.');
    return;
  }

  let exibidos = 0;
  let mudou = false;
  for (const n of pendentes) {
    if (avisadas.has(n.id)) continue; // já avisada: não repete
    if (exibidos >= 3) break; // no máximo 3 balões por ciclo; o resto sai no próximo
    avisadas.add(n.id);
    mudou = true;
    exibidos += 1;
    const d = n.dados || {};
    const linha1 = n.mensagem || '';
    const linha2 = 'Brazil Transports · abra o sistema para ver os detalhes.';
    log('Aviso novo: ' + n.id + ' (' + n.tipo + ') — ' + n.titulo);
    mostrarToast(n.titulo || ('Chamado ' + (d.chamadoId || '')), linha1, linha2);
  }

  // Tira da memória ids que já foram vistos/resolvidos no sistema (uma
  // notificação reconhecida nunca volta a ficar pendente).
  const idsPendentes = new Set(pendentes.map((n) => n.id));
  for (const id of [...avisadas]) {
    if (!idsPendentes.has(id)) { avisadas.delete(id); mudou = true; }
  }
  if (mudou) salvarAvisadas();
}

log('Notificador Brazil Transports iniciado. Servidor: ' + BASE + ' · consulta a cada ' + (INTERVALO / 1000) +
  's · cada notificação NOVA é exibida uma única vez.');

let falhasSeguidas = 0;
async function ciclo() {
  try {
    await verificar();
    falhasSeguidas = 0;
  } catch (e) {
    falhasSeguidas += 1;
    token = '';
    // Loga a 1ª falha e depois a cada 10, para não encher o log quando a rede cai.
    if (falhasSeguidas === 1 || falhasSeguidas % 10 === 0) {
      log('Sem contato com o servidor (' + e.message + '). Tentando de novo…');
    }
  } finally {
    setTimeout(ciclo, INTERVALO);
  }
}
ciclo();
