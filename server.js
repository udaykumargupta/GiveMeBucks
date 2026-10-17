// GiveMeBucks — local server. Serves the dashboard, stores data in
// ./data/db.json, and sends a macOS reminder when data is due.
// Zero dependencies: run with `node server.js` (or `npm start`).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { Store } from './lib/store.js';
import { notify } from './lib/notify.js';
import { dueItems, todayISO, withDefaults } from './public/js/calc.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.GROWTH_DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 4180;
const URL_BASE = `http://localhost:${PORT}`;
const REMINDER_STATE = path.join(DATA, 'reminder-state.json');

const store = new Store(DATA);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
// Only answer requests addressed to this machine (blocks DNS-rebinding reads).
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

function send(res, status, body, type = 'application/json') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(payload);
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function validDb(db) {
  return db && typeof db === 'object' &&
    ['accounts', 'snapshots', 'income'].every((k) => Array.isArray(db[k])) &&
    typeof (db.settings ?? {}) === 'object';
}

// ------------------------------------------------------------------ reminders
function readReminderState() {
  try { return JSON.parse(fs.readFileSync(REMINDER_STATE, 'utf8')); } catch { return {}; }
}
function writeReminderState(state) {
  fs.writeFileSync(REMINDER_STATE, JSON.stringify(state, null, 2));
}

async function sendReminder(items, { test = false } = {}) {
  const actionable = items.filter((i) => i.severity !== 'info');
  if (!actionable.length && !test) return false;
  const message = actionable.length
    ? actionable.map((i) => i.title).join(' · ')
    : 'All caught up — nothing to update right now.';
  const subtitle = actionable.length
    ? `${actionable.length} update${actionable.length > 1 ? 's' : ''} needed`
    : 'Test reminder';
  return notify({ title: 'GiveMeBucks', subtitle, message, url: `${URL_BASE}/#checkin` });
}

async function maybeRemind(now = new Date()) {
  const db = store.read();
  const { reminders } = withDefaults(db).settings;
  if (!reminders.enabled) return;
  const today = todayISO(now);
  const [hh, mm] = String(reminders.notifyAt || '20:00').split(':').map(Number);
  if (now.getHours() * 60 + now.getMinutes() < hh * 60 + (mm || 0)) return;
  const state = readReminderState();
  if (state.lastCheckedDate === today) return;
  const items = dueItems(db, today);
  const sent = await sendReminder(items);
  writeReminderState({ ...state, lastCheckedDate: today, lastSentAt: sent ? now.toISOString() : state.lastSentAt, lastItems: items.map((i) => i.title) });
  if (sent) console.log(`[reminder] sent ${now.toLocaleString()}: ${items.map((i) => i.title).join(' · ')}`);
}

// --------------------------------------------------------------------- routes
async function handleApi(req, res, url) {
  if (url.pathname === '/api/db' && req.method === 'GET') return send(res, 200, store.read());

  if (url.pathname === '/api/db' && req.method === 'PUT') {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'JSON only' });
    const incoming = JSON.parse(await readBody(req));
    if (!validDb(incoming)) return send(res, 400, { error: 'Invalid data shape' });
    const current = store.read();
    if ((incoming.rev ?? 0) !== (current.rev ?? 0)) return send(res, 409, { error: 'Data changed in another tab', db: current });
    const next = { ...incoming, rev: (current.rev ?? 0) + 1, savedAt: new Date().toISOString() };
    store.write(next);
    return send(res, 200, { rev: next.rev, savedAt: next.savedAt });
  }

  if (url.pathname === '/api/due' && req.method === 'GET') return send(res, 200, dueItems(store.read(), todayISO()));

  if (url.pathname === '/api/reminder/test' && req.method === 'POST') {
    const ok = await sendReminder(dueItems(store.read(), todayISO()), { test: true });
    return send(res, 200, { ok });
  }

  if (url.pathname === '/api/reminder/status' && req.method === 'GET') return send(res, 200, readReminderState());

  return send(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 421, 'Misdirected request', 'text/plain');
  const url = new URL(req.url, URL_BASE);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`GiveMeBucks running at ${URL_BASE}`);
  console.log(`Data file: ${store.file}`);
  if (process.argv.includes('--open')) execFile('/usr/bin/open', [URL_BASE], () => {});
  maybeRemind().catch((e) => console.error('[reminder]', e));
  setInterval(() => maybeRemind().catch((e) => console.error('[reminder]', e)), 5 * 60 * 1000);
});
