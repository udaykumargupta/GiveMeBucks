// HTTP request handler: static files + JSON API, shared by the local server
// (local-server.js) and the Vercel function (api/index.js). Sign-in follows Kairos:
//   GET  /api/public/config  → { googleClientId, authRequired, ... }
//   POST /api/auth/google    → { idToken } in, { token, user } out
//   everything else under /api needs "Authorization: Bearer <token>" when
//   sign-in is enabled. Without a Google client id the local server runs
//   single-user, exactly as before; a deployment (requireAuth) refuses to.
// Data routes (v2 documents only; errors are { code, error, path? }):
//   GET /api/db     → the v2 document, migrated from v1 on the first read
//   PUT /api/db     → { rev, savedAt } | 409 { code: 'conflict', db }
//   GET /api/db/v1  → the untouched v1 document, or 404
import fs from 'node:fs';
import path from 'node:path';
import { AuthError, isAllowed, safeUserId } from './auth.js';
import { todayIST } from '../public/js/dates.js';
import { emptyDoc, isV1Shaped, migrate, validateDoc } from '../public/js/model.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** A data-route failure: sent as { code, error: <human text>, path? }. */
class ApiError extends Error {
  constructor(status, body) {
    super(body.error);
    this.status = status;
    this.body = body;
  }
}

export function send(res, status, body, type = 'application/json') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(payload);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const onData = (c) => {
      size += c.length;
      if (size <= limit) return chunks.push(c);
      // Discard the rest instead of destroying the request, so the 413 reaches the browser.
      req.off('data', onData);
      req.resume();
      chunks.length = 0;
      reject(new ApiError(413, { code: 'too_large', error: 'Data too large' }));
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new ApiError(415, { code: 'bad_request', error: 'JSON only' });
  const raw = await readBody(req);
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, { code: 'bad_request', error: 'Malformed JSON' });
  }
}

const OUTDATED = { code: 'outdated_client', error: 'GiveMeBucks was updated — reload the page.' };
const MIGRATION_FAILED = { code: 'migration_failed', error: "Couldn't upgrade your data — nothing was changed." };

const unauthorized = (res) => send(res, 401, { error: 'unauthorized', message: 'Authentication required' });
const forbidden = (res) => send(res, 403, { error: 'forbidden', message: 'This Google account is not allowed to use this GiveMeBucks.' });

/**
 * auth:      { enabled, clientId, allow:Set, sessions, verifyGoogle }
 * storage:   see lib/storage.js
 * requireAuth: refuse to serve data unless sign-in is configured (deployments).
 * setupMissing: names of settings a deployment still needs (shown on the sign-in page).
 * now, today: clock and "today" (ISO date in India), injectable for tests.
 */
export function createHandler({
  publicDir, auth, storage, requireAuth = false, setupMissing = [], log = console,
  now = () => new Date(), today = () => todayIST(now()),
}) {
  const misconfigured = setupMissing.length > 0 || (requireAuth && !auth.enabled);

  /** The signed-in caller, or null. In local mode everyone is the single local user. */
  function caller(req) {
    if (!auth.enabled) return { local: true, sub: 'local' };
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) return null;
    return auth.sessions.verify(header.slice(7));
  }
  const idOf = (user) => (user.local ? 'local' : safeUserId(user.sub));

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
    if (auth.allow.size > 0 && !auth.allow.has('*') && await storage.claimLegacy(id)) log.log?.(`[auth] moved local data to ${google.email}'s account`);
    const token = auth.sessions.issue(google);
    return send(res, 200, { token, user: { email: google.email, name: google.name, picture: google.picture } });
  }

  /**
   * The account's v2 document. The first read after the upgrade migrates the v1
   * document into the separate v2 store (v1 itself is never written).
   */
  async function readV2(id) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const doc = await storage.read(id);
      if (doc) return doc;
      const v1 = await storage.readV1(id);
      if (!v1) return emptyDoc();
      const day = today();
      const savedAt = now().toISOString();
      let next, check;
      try {
        next = migrate(v1, day, savedAt);
        check = validateDoc(next, { today: day });
      } catch (err) {
        check = { ok: false, error: err.message };
      }
      if (!check.ok) {
        log.error?.(`[migrate] ${id}: ${check.error}`);
        throw new ApiError(500, MIGRATION_FAILED);
      }
      if (!next.legacyV1 && !next.places.length && !next.entries.length) return next; // nothing to keep: no write
      const doc2 = { ...next, rev: 1, savedAt };
      if ((await storage.write(id, doc2, 0)).ok) {
        log.log?.(`[migrate] ${id}: upgraded to v2 (${next.places.length} places, ${next.entries.length} entries)`);
        return doc2;
      }
      // Another request migrated at the same moment: read what it saved.
    }
    throw new Error(`could not read or migrate ${id}`);
  }

  async function saveV2(id, req, res) {
    const incoming = await readJson(req);
    if (isV1Shaped(incoming)) return send(res, 400, OUTDATED);
    const check = validateDoc(incoming, { today: today() });
    if (!check.ok) return send(res, 400, { code: 'invalid', error: check.error, path: check.path });
    const stored = await readV2(id); // migrates first, so a save can never hide unmigrated v1 data
    const expectedRev = incoming.rev ?? 0;
    const next = { ...incoming, rev: expectedRev + 1, savedAt: now().toISOString() };
    // Older clients and edits don't carry the v1 archive; never drop it by accident.
    if (!('legacyV1' in incoming) && stored.legacyV1) next.legacyV1 = stored.legacyV1;
    const saved = await storage.write(id, next, expectedRev);
    if (!saved.ok) return send(res, 409, { code: 'conflict', error: 'Changed on another device', db: saved.current || emptyDoc() });
    return send(res, 200, { rev: saved.rev, savedAt: next.savedAt });
  }

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/public/config') {
      return send(res, 200, {
        googleClientId: auth.enabled ? auth.clientId : null,
        authRequired: auth.enabled || requireAuth,
        restricted: auth.enabled && auth.allow.size > 0 && !auth.allow.has('*'),
        storage: storage.kind,
        setupMissing,
      });
    }
    if (misconfigured) {
      return send(res, 503, { error: 'not_configured', message: `This deployment isn't set up yet. Missing: ${setupMissing.join(', ') || 'GOOGLE_CLIENT_ID'}.` });
    }
    if (route === 'POST /api/auth/google') return login(req, res);

    const user = caller(req);
    if (!user) return unauthorized(res);
    // Re-check the allowlist on every call, so removing an email takes effect immediately.
    if (!user.local && !isAllowed(user.email, auth.allow)) return forbidden(res);
    const id = idOf(user);

    if (route === 'GET /api/me') {
      return send(res, 200, user.local ? { local: true } : { email: user.email, name: user.name, picture: user.picture });
    }
    if (route === 'GET /api/db') return send(res, 200, await readV2(id));
    if (route === 'PUT /api/db') return saveV2(id, req, res);
    if (route === 'GET /api/db/v1') {
      const v1 = await storage.readV1(id);
      return v1 ? send(res, 200, v1) : send(res, 404, { code: 'not_found', error: 'No data from the earlier version.' });
    }
    return send(res, 404, { code: 'not_found', error: 'Not found' });
  }

  function serveStatic(req, res, url) {
    if (!publicDir) return send(res, 404, 'Not found', 'text/plain');
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
      if (err instanceof ApiError) return send(res, err.status, err.body);
      if (err instanceof AuthError) return send(res, err.status, { error: err.status === 401 ? 'unauthorized' : 'error', message: err.message });
      log.error?.(err);
      return send(res, 500, { error: 'server_error', message: 'Something went wrong on the server.' });
    }
  };
}
