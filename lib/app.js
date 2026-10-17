// HTTP request handler: static files + JSON API. Sign-in follows Kairos:
//   GET  /api/public/config  → { googleClientId, authRequired }
//   POST /api/auth/google    → { idToken } in, { token, user } out
//   everything else under /api needs "Authorization: Bearer <token>" when
//   sign-in is enabled. Without a Google client id the app runs single-user,
//   exactly as before (local mode).
import fs from 'node:fs';
import path from 'node:path';
import { AuthError, isAllowed, safeUserId } from './auth.js';
import { legacyStore, userStore, claimLegacy } from './store.js';
import { dueItems, todayISO } from '../public/js/calc.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function send(res, status, body, type = 'application/json') {
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

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new AuthError('JSON only', 415);
  try {
    return JSON.parse(await readBody(req));
  } catch {
    throw new AuthError('Malformed JSON', 400);
  }
}

function validDb(db) {
  return db && typeof db === 'object' &&
    ['accounts', 'snapshots', 'income'].every((k) => Array.isArray(db[k])) &&
    typeof (db.settings ?? {}) === 'object';
}

const unauthorized = (res) => send(res, 401, { error: 'unauthorized', message: 'Authentication required' });
const forbidden = (res) => send(res, 403, { error: 'forbidden', message: 'This Google account is not allowed to use this GiveMeBucks.' });

/**
 * auth: { enabled, clientId, allow:Set, sessions, verifyGoogle }
 * reminders: { test(userId, db, user) → Promise<boolean>, status(userId) → object }
 */
export function createHandler({ publicDir, dataDir, auth, reminders, log = console }) {
  const storeFor = (user) => (user.local ? legacyStore(dataDir) : userStore(dataDir, safeUserId(user.sub)));

  /** The signed-in caller, or null. In local mode everyone is the single local user. */
  function caller(req) {
    if (!auth.enabled) return { local: true, sub: 'local' };
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) return null;
    return auth.sessions.verify(header.slice(7));
  }

  async function login(req, res) {
    if (!auth.enabled) return send(res, 400, { error: 'bad_request', message: 'Google sign-in is not enabled on this server.' });
    const { idToken } = await readJson(req);
    const google = await auth.verifyGoogle(idToken);
    if (!isAllowed(google.email, auth.allow)) {
      log.warn?.(`[auth] refused sign-in for ${google.email}`);
      return forbidden(res);
    }
    const id = safeUserId(google.sub);
    // Only an explicitly allow-listed account may take over the pre-sign-in data.
    if (auth.allow.size > 0 && claimLegacy(dataDir, id)) log.log?.(`[auth] moved local data to ${google.email}'s account`);
    const token = auth.sessions.issue(google);
    return send(res, 200, { token, user: { email: google.email, name: google.name, picture: google.picture } });
  }

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/public/config') {
      return send(res, 200, { googleClientId: auth.enabled ? auth.clientId : null, authRequired: auth.enabled, restricted: auth.enabled && auth.allow.size > 0 });
    }
    if (route === 'POST /api/auth/google') return login(req, res);

    const user = caller(req);
    if (!user) return unauthorized(res);
    // Re-check the allowlist on every call, so removing an email takes effect immediately.
    if (!user.local && !isAllowed(user.email, auth.allow)) return forbidden(res);
    const store = storeFor(user);

    if (route === 'GET /api/me') {
      return send(res, 200, user.local ? { local: true } : { email: user.email, name: user.name, picture: user.picture });
    }
    if (route === 'GET /api/db') return send(res, 200, store.read());
    if (route === 'PUT /api/db') {
      const incoming = await readJson(req);
      if (!validDb(incoming)) return send(res, 400, { error: 'Invalid data shape' });
      const current = store.read();
      if ((incoming.rev ?? 0) !== (current.rev ?? 0)) return send(res, 409, { error: 'Data changed in another tab', db: current });
      const next = { ...incoming, rev: (current.rev ?? 0) + 1, savedAt: new Date().toISOString() };
      store.write(next);
      return send(res, 200, { rev: next.rev, savedAt: next.savedAt });
    }
    if (route === 'GET /api/due') return send(res, 200, dueItems(store.read(), todayISO()));
    if (route === 'POST /api/reminder/test') return send(res, 200, { ok: await reminders.test(user.sub, store.read(), user) });
    if (route === 'GET /api/reminder/status') return send(res, 200, reminders.status(user.sub));
    return send(res, 404, { error: 'Not found' });
  }

  function serveStatic(req, res, url) {
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request', 'text/plain'); }
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'Not found', 'text/plain');
      send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
    });
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      return serveStatic(req, res, url);
    } catch (err) {
      if (err instanceof AuthError) return send(res, err.status, { error: err.status === 401 ? 'unauthorized' : 'error', message: err.message });
      log.error?.(err);
      return send(res, 500, { error: 'server_error', message: err.message });
    }
  };
}
