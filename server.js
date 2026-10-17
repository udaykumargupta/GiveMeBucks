// GiveMeBucks — local server. Serves the dashboard and JSON API (lib/app.js),
// stores data under ./data, and sends a macOS reminder when data is due.
// Settings come from the environment or a .env file (see .env.example).
// Zero dependencies: run with `node server.js` (or `npm start`).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createHandler, send } from './lib/app.js';
import { createGoogleVerifier, createSessions, parseAllowlist, MIN_SECRET_LENGTH } from './lib/auth.js';
import { legacyStore, userStore, listUserIds } from './lib/store.js';
import { notify } from './lib/notify.js';
import { dueItems, todayISO, withDefaults } from './public/js/calc.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(ROOT, '.env');
if (typeof process.loadEnvFile === 'function' && fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const env = (key, fallback = '') => (process.env[key] ?? '').trim() || fallback;
const PUBLIC = path.join(ROOT, 'public');
const DATA = env('GIVEMEBUCKS_DATA_DIR', env('GROWTH_DATA_DIR', path.join(ROOT, 'data')));
const PORT = Number(env('PORT')) || 4180;
const URL_BASE = `http://localhost:${PORT}`;
const REMINDER_STATE = path.join(DATA, 'reminder-state.json');
fs.mkdirSync(DATA, { recursive: true });

// ---------------------------------------------------------------- sign-in
const GOOGLE_CLIENT_ID = env('GOOGLE_CLIENT_ID');
const auth = { enabled: Boolean(GOOGLE_CLIENT_ID), clientId: GOOGLE_CLIENT_ID, allow: parseAllowlist(env('ALLOWED_EMAILS')) };
if (auth.enabled) {
  const secret = env('JWT_SECRET');
  if (secret.length < MIN_SECRET_LENGTH) {
    console.error(`GOOGLE_CLIENT_ID is set, so JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
    console.error('Generate one with:  openssl rand -base64 48   and put it in .env as JWT_SECRET=...');
    process.exit(1);
  }
  auth.sessions = createSessions({ secret, ttlMs: Number(env('JWT_EXPIRATION_MS', String(7 * 24 * 60 * 60 * 1000))) });
  auth.verifyGoogle = createGoogleVerifier({ clientId: GOOGLE_CLIENT_ID });
}

// -------------------------------------------------------------- reminders
// State per user: { users: { <id>: { lastCheckedDate, lastSentAt, lastItems } } }
function readReminderState() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(REMINDER_STATE, 'utf8')); } catch { /* first run */ }
  if (!s.users) s = { users: s.lastCheckedDate ? { local: s } : {} }; // older single-user format
  return s;
}
function writeReminderState(state) {
  fs.writeFileSync(REMINDER_STATE, JSON.stringify(state, null, 2));
}

async function sendReminder(items, { test = false, name = '' } = {}) {
  const actionable = items.filter((i) => i.severity !== 'info');
  if (!actionable.length && !test) return false;
  const message = actionable.length
    ? actionable.map((i) => i.title).join(' · ')
    : 'All caught up — nothing to update right now.';
  const who = name ? ` · ${name.split(' ')[0]}` : '';
  const subtitle = actionable.length
    ? `${actionable.length} update${actionable.length > 1 ? 's' : ''} needed${who}`
    : `Test reminder${who}`;
  return notify({ title: 'GiveMeBucks', subtitle, message, url: `${URL_BASE}/#checkin` });
}

const storeForId = (id) => (id === 'local' ? legacyStore(DATA) : userStore(DATA, id));

async function maybeRemind(now = new Date()) {
  const today = todayISO(now);
  const state = readReminderState();
  let changed = false;
  for (const id of auth.enabled ? listUserIds(DATA) : ['local']) {
    const db = storeForId(id).read();
    const { reminders } = withDefaults(db).settings;
    if (!reminders.enabled) continue;
    const [hh, mm] = String(reminders.notifyAt || '20:00').split(':').map(Number);
    if (now.getHours() * 60 + now.getMinutes() < hh * 60 + (mm || 0)) continue;
    const mine = state.users[id] || {};
    if (mine.lastCheckedDate === today) continue;
    const items = dueItems(db, today);
    const sent = await sendReminder(items, { name: withDefaults(db).settings.owner });
    state.users[id] = { lastCheckedDate: today, lastSentAt: sent ? now.toISOString() : mine.lastSentAt, lastItems: items.map((i) => i.title) };
    changed = true;
    if (sent) console.log(`[reminder] sent ${now.toLocaleString()}: ${items.map((i) => i.title).join(' · ')}`);
  }
  if (changed) writeReminderState(state);
}

const reminders = {
  test: (userId, db, user) => sendReminder(dueItems(db, todayISO()), { test: true, name: user.name }),
  status: (userId) => readReminderState().users[userId] || {},
};

// ----------------------------------------------------------------- server
const handle = createHandler({ publicDir: PUBLIC, dataDir: DATA, auth, reminders });
// Only answer requests addressed to this machine (blocks DNS-rebinding reads).
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

const server = http.createServer((req, res) => {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 421, 'Misdirected request', 'text/plain');
  return handle(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`GiveMeBucks running at ${URL_BASE}`);
  if (!auth.enabled) {
    console.log(`Sign-in: off (local mode). Data: ${legacyStore(DATA).file}`);
    console.log('         Set GOOGLE_CLIENT_ID and JWT_SECRET in .env to require Google sign-in.');
  } else {
    console.log(`Sign-in: Google — ${auth.allow.size ? `only ${[...auth.allow].join(', ')}` : 'any Google account (each gets a private dashboard)'}`);
    console.log(`Data: ${path.join(DATA, 'users')}`);
    if (legacyStore(DATA).exists() && !auth.allow.size) {
      console.log('Note: data/db.json (from before sign-in) is not linked to an account. Add your email to');
      console.log('      ALLOWED_EMAILS and it moves to your account the first time you sign in.');
    }
  }
  if (process.argv.includes('--open')) execFile('/usr/bin/open', [URL_BASE], () => {});
  maybeRemind().catch((e) => console.error('[reminder]', e));
  setInterval(() => maybeRemind().catch((e) => console.error('[reminder]', e)), 5 * 60 * 1000);
});
