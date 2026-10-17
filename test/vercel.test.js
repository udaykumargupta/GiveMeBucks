// The Vercel function must fail closed until it is fully configured.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createVercelHandler } from '../api/index.js';
import { createSessions } from '../lib/auth.js';

const SECRET = 'z'.repeat(48);
const FULL = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', JWT_SECRET: SECRET, ALLOWED_EMAILS: 'me@example.com', DATABASE_URL: 'postgres://user:pw@db.example.com/neondb' };

async function serve(env) {
  const server = http.createServer(createVercelHandler(env));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p, headers = {}) => { const r = await fetch(base + p, { headers }); return { status: r.status, json: await r.json() }; };
  return { get, close: () => new Promise((r) => server.close(r)) };
}

test('unconfigured deployment serves no data and says what is missing', async () => {
  const s = await serve({});
  try {
    const cfg = (await s.get('/api/public/config')).json;
    assert.equal(cfg.authRequired, true);
    assert.equal(cfg.googleClientId, null);
    assert.deepEqual(cfg.setupMissing, ['GOOGLE_CLIENT_ID', 'JWT_SECRET (32+ characters)', 'ALLOWED_EMAILS', 'DATABASE_URL (connect a Neon database)']);
    assert.equal((await s.get('/api/db')).status, 503);
  } finally { await s.close(); }
});

test('an empty allowlist is refused in the cloud; "*" opts in to any account', async () => {
  const open = await serve({ ...FULL, ALLOWED_EMAILS: '' });
  try {
    assert.deepEqual((await open.get('/api/public/config')).json.setupMissing, ['ALLOWED_EMAILS']);
  } finally { await open.close(); }
  const anyone = await serve({ ...FULL, ALLOWED_EMAILS: '*' });
  try {
    const cfg = (await anyone.get('/api/public/config')).json;
    assert.deepEqual(cfg.setupMissing, []);
    assert.equal(cfg.restricted, false);
  } finally { await anyone.close(); }
});

test('configured deployment requires a valid session and accepts POSTGRES_URL', async () => {
  const s = await serve({ ...FULL, DATABASE_URL: '', POSTGRES_URL: FULL.DATABASE_URL });
  try {
    const cfg = (await s.get('/api/public/config')).json;
    assert.deepEqual(cfg, { googleClientId: FULL.GOOGLE_CLIENT_ID, authRequired: true, restricted: true, storage: 'database', reminders: 'none', setupMissing: [] });
    assert.equal((await s.get('/api/db')).status, 401);
    assert.equal((await s.get('/api/db', { Authorization: 'Bearer forged.token.here' })).status, 401);
    // A valid session for an email outside the allowlist is refused before any database access.
    const outsider = createSessions({ secret: SECRET }).issue({ sub: '9', email: 'outsider@example.com', name: 'O' });
    assert.equal((await s.get('/api/db', { Authorization: `Bearer ${outsider}` })).status, 403);
  } finally { await s.close(); }
});
