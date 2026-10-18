// GiveMeBucks — local server. Serves the app and JSON API (lib/app.js) and
// stores data under ./data.
// Settings come from the environment or a .env file (see .env.example).
// Zero dependencies: run with `npm start` (node local-server.js).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createHandler, send } from './lib/app.js';
import { createGoogleVerifier, createSessions, parseAllowlist, MIN_SECRET_LENGTH, SESSION_TTL_MS } from './lib/auth.js';
import { legacyStore, legacyStoreV2 } from './lib/store.js';
import { createStorage } from './lib/storage.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(ROOT, '.env');
if (typeof process.loadEnvFile === 'function' && fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const env = (key, fallback = '') => (process.env[key] ?? '').trim() || fallback;
const PUBLIC = path.join(ROOT, 'public');
const DATA = env('GIVEMEBUCKS_DATA_DIR', env('GROWTH_DATA_DIR', path.join(ROOT, 'data')));
const PORT = Number(env('PORT')) || 4180;
const URL_BASE = `http://localhost:${PORT}`;
fs.mkdirSync(DATA, { recursive: true });
const storage = createStorage({ env: process.env, dataDir: DATA });

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
  auth.sessions = createSessions({ secret, ttlMs: Number(env('JWT_EXPIRATION_MS')) || SESSION_TTL_MS });
  auth.verifyGoogle = createGoogleVerifier({ clientId: GOOGLE_CLIENT_ID });
}

// ----------------------------------------------------------------- server
const handle = createHandler({ publicDir: PUBLIC, auth, storage });
// Only answer requests addressed to this machine (blocks DNS-rebinding reads).
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

const server = http.createServer((req, res) => {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 421, 'Misdirected request', 'text/plain');
  return handle(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`GiveMeBucks running at ${URL_BASE}`);
  const where = storage.kind === 'database' ? 'Neon Postgres (DATABASE_URL)' : auth.enabled ? path.join(DATA, 'users') : legacyStoreV2(DATA).file;
  if (!auth.enabled) {
    console.log(`Sign-in: off (local mode). Data: ${where}`);
    console.log('         Set GOOGLE_CLIENT_ID and JWT_SECRET in .env to require Google sign-in.');
  } else {
    console.log(`Sign-in: Google — ${auth.allow.size && !auth.allow.has('*') ? `only ${[...auth.allow].join(', ')}` : 'any Google account (each gets a private dashboard)'}`);
    console.log(`Data: ${where}`);
    if (storage.kind === 'file' && (legacyStore(DATA).exists() || legacyStoreV2(DATA).exists()) && !auth.allow.size) {
      console.log('Note: the data from before sign-in (data/db.json, data/db.v2.json) is not linked to an account. Add your email to');
      console.log('      ALLOWED_EMAILS and it moves to your account the first time you sign in.');
    }
  }
  if (process.argv.includes('--open')) execFile('/usr/bin/open', [URL_BASE], () => {});
});
