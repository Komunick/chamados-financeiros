'use strict';
/*
 * Chamados Financeiros — camada de dados do servidor.
 * ---------------------------------------------------------------------------
 * Node puro, SEM dependências externas. Os dados vivem num único arquivo JSON
 * FORA da pasta servida por HTTP (chamados-data/), então nunca são baixáveis
 * pelo navegador. Mesmas proteções do Controle Patrimonial:
 *  - arquivo corrompido vai para quarentena e o servidor aborta (não re-semeia);
 *  - gravação atômica com fsync;
 *  - snapshots rotativos em chamados-data/backups.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.CHAMADOS_DATA_DIR || path.join(__dirname, '..', '..', 'chamados-data');
const DATA_FILE = path.join(DATA_DIR, 'chamados.json');
const ANEXOS_DIR = path.join(DATA_DIR, 'anexos');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(ANEXOS_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function agora() { return new Date().toISOString(); }

// ---------------------------------------------------------------------------
// Carga com guarda contra corrupção.
// ---------------------------------------------------------------------------
let db = null;
try {
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.chamados) || !Array.isArray(parsed.usuarios)) {
    throw new Error('estrutura inesperada no arquivo de dados');
  }
  db = parsed;
} catch (e) {
  if (e.code === 'ENOENT') {
    db = null; // primeira execução → semear abaixo
  } else {
    const quarantine = DATA_FILE + '.corrupt-' + stamp();
    try { fs.renameSync(DATA_FILE, quarantine); } catch (_) { /* ignore */ }
    console.error('[Chamados] FALHA ao ler a base (' + (e && e.message) + ').');
    console.error('[Chamados] Arquivo preservado em: ' + quarantine);
    console.error('[Chamados] Restaure um backup de ' + BACKUP_DIR + ' (renomeie para chamados.json) e reinicie.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Senhas (scrypt com sal por usuário).
// ---------------------------------------------------------------------------
function hashSenha(senha, sal) {
  return crypto.scryptSync(String(senha), sal, 32).toString('hex');
}
function novoSal() { return crypto.randomBytes(16).toString('hex'); }

function criarUsuarioObj(nome, login, senha, papel) {
  const sal = novoSal();
  return {
    id: 'U-' + String(++db.seq.usuario).padStart(4, '0'),
    nome: String(nome),
    login: String(login).toLowerCase(),
    sal,
    senhaHash: hashSenha(senha, sal),
    papel, // 'solicitante' | 'financeiro' | 'admin'
    criadoEm: agora(),
  };
}

if (!db) {
  db = {
    versao: 1,
    usuarios: [],
    sessoes: [],
    chamados: [],
    notificacoes: [],
    seq: { usuario: 0, chamado: 0, notificacao: 0, anexo: 0 },
  };
  db.usuarios.push(criarUsuarioObj('Administrador', 'admin', 'admin123', 'admin'));
  console.log('[Chamados] primeira execução: usuário admin/admin123 criado (troque a senha!).');
}
if (!db.seq) db.seq = { usuario: db.usuarios.length, chamado: 0, notificacao: 0, anexo: 0 };
if (!Array.isArray(db.sessoes)) db.sessoes = [];
if (!Array.isArray(db.notificacoes)) db.notificacoes = [];

// Migração: chamados antigos (antes do tipo "compra") viram tipo "viagem".
for (const c of db.chamados) {
  if (!c.tipo) c.tipo = 'viagem';
  if (c.dataViagem === undefined) c.dataViagem = null;
  if (c.rota === undefined) c.rota = '';
}

// ---------------------------------------------------------------------------
// Persistência atômica + snapshots.
// ---------------------------------------------------------------------------
function flush() {
  const tmp = DATA_FILE + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(db));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, DATA_FILE);
}

function rotateBackups(keep) {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^chamados-.*\.json$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of files.slice(keep || 40)) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, old.f)); } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }
}

function snapshot(reason) {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    const bak = path.join(BACKUP_DIR, 'chamados-' + stamp() + '-' + (reason || 'auto') + '.json');
    fs.copyFileSync(DATA_FILE, bak);
    rotateBackups(40);
    return bak;
  } catch (e) { return null; }
}

// Garante que a primeira execução já fique no disco.
if (!fs.existsSync(DATA_FILE)) flush();
snapshot('startup');

// ---------------------------------------------------------------------------
// Sessões.
// ---------------------------------------------------------------------------
const SESSAO_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

function limparSessoes() {
  const t = Date.now();
  const antes = db.sessoes.length;
  db.sessoes = db.sessoes.filter((s) => Date.parse(s.expiraEm) > t);
  if (db.sessoes.length !== antes) flush();
}
limparSessoes();

function criarSessao(usuario) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessoes.push({
    token,
    usuarioId: usuario.id,
    criadaEm: agora(),
    expiraEm: new Date(Date.now() + SESSAO_MS).toISOString(),
  });
  // Não deixa a lista crescer sem limite.
  if (db.sessoes.length > 500) db.sessoes = db.sessoes.slice(-300);
  flush();
  return token;
}

function usuarioPorToken(token) {
  if (!token) return null;
  const s = db.sessoes.find((x) => x.token === token);
  if (!s) return null;
  if (Date.parse(s.expiraEm) < Date.now()) return null;
  return db.usuarios.find((u) => u.id === s.usuarioId) || null;
}

function encerrarSessao(token) {
  db.sessoes = db.sessoes.filter((s) => s.token !== token);
  flush();
}

// ---------------------------------------------------------------------------
// IDs.
// ---------------------------------------------------------------------------
function novoIdChamado() { return 'CH-' + String(++db.seq.chamado).padStart(6, '0'); }
function novoIdNotificacao() { return 'N-' + String(++db.seq.notificacao).padStart(6, '0'); }
function novoIdAnexo() { return 'AX-' + String(++db.seq.anexo).padStart(6, '0'); }

module.exports = {
  db,
  flush,
  snapshot,
  DATA_DIR,
  DATA_FILE,
  ANEXOS_DIR,
  BACKUP_DIR,
  agora,
  hashSenha,
  novoSal,
  criarUsuarioObj,
  criarSessao,
  usuarioPorToken,
  encerrarSessao,
  limparSessoes,
  novoIdChamado,
  novoIdNotificacao,
  novoIdAnexo,
};
