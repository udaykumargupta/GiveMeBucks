// End-to-end tests of the HTTP API (lib/app.js) with a stubbed Google verifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../lib/app.js';
import { createSessions, parseAllowlist, AuthError } from '../lib/auth.js';
import { fileStorage } from '../lib/storage.js';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const quiet = { log() {}, warn() {}, error() {} };

// Stub: an ID token "good:<sub>:<email>" is valid; anything else is not.
async function fakeGoogle(idToken) {
  const [kind, sub, email] = String(idToken).split(':');
  if (kind !== 'good') throw new AuthError('Invalid Google ID token');
  return { sub, email, name: 'Test User', picture: '' };
}

async function start({ signIn = true, allow = '' } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmb-test-'));
  const sessions = createSessions({ secret: 's'.repeat(48) });
  const auth = signIn
    ? { enabled: true, clientId: 'client-123', allow: parseAllowlist(allow), sessions, verifyGoogle: fakeGoogle }
    : { enabled: false, allow: new Set() };
  const reminders = { kind: 'macos', test: async () => true, status: () => ({}) };
  const server = http.createServer(createHandler({ publicDir: PUBLIC, auth, storage: fileStorage(dataDir), reminders, log: quiet }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, { token, body, type = 'application/json' } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = type;
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
  };
  const login = async (sub, email) => (await call('POST', '/api/auth/google', { body: { idToken: `good:${sub}:${email}` } }));
  const close = () => new Promise((r) => server.close(r));
  return { dataDir, sessions, call, login, close };
}

const doc = (extra = {}) => ({ rev: 0, accounts: [{ id: 'a', name: 'HDFC', kind: 'bank' }], snapshots: [], income: [], settings: {}, ...extra });

test('local mode (no Google client id) works without sign-in, as before', async () => {
  const s = await start({ signIn: false });
  try {
    assert.deepEqual((await s.call('GET', '/api/public/config')).json, { googleClientId: null, authRequired: false, restricted: false, storage: 'file', reminders: 'macos', setupMissing: [] });
    assert.equal((await s.call('GET', '/api/db')).status, 200);
    assert.equal((await s.call('PUT', '/api/db', { body: doc() })).json.rev, 1);
    assert.ok(fs.existsSync(path.join(s.dataDir, 'db.json')));
    assert.equal((await s.call('POST', '/api/auth/google', { body: { idToken: 'good:1:a@example.com' } })).status, 400);
  } finally { await s.close(); }
});

test('with sign-in on, the API needs a valid session token', async () => {
  const s = await start({ allow: 'me@example.com' });
  try {
    assert.deepEqual((await s.call('GET', '/api/public/config')).json, { googleClientId: 'client-123', authRequired: true, restricted: true, storage: 'file', reminders: 'macos', setupMissing: [] });
    const anon = await s.call('GET', '/api/db');
    assert.equal(anon.status, 401);
    assert.deepEqual(anon.json, { error: 'unauthorized', message: 'Authentication required' });
    assert.equal((await s.call('GET', '/api/db', { token: 'not.a.token' })).status, 401);
    assert.equal((await s.call('POST', '/api/auth/google', { body: { idToken: 'bad' } })).status, 401);

    const ok = await s.login('111', 'me@example.com');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.user, { email: 'me@example.com', name: 'Test User', picture: '' });
    const token = ok.json.token;
    assert.equal((await s.call('GET', '/api/me', { token })).json.email, 'me@example.com');
    assert.equal((await s.call('PUT', '/api/db', { token, body: doc() })).json.rev, 1);
    assert.equal((await s.call('GET', '/api/db', { token })).json.accounts[0].name, 'HDFC');
    assert.ok(fs.existsSync(path.join(s.dataDir, 'users', '111.json')), 'stored per user');
    assert.equal((await s.call('GET', '/api/due', { token })).status, 200);
    assert.equal((await s.call('POST', '/api/reminder/test', { token })).json.ok, true);
  } finally { await s.close(); }
});

test('a save from a stale tab is refused with the latest data', async () => {
  const s = await start({ signIn: false });
  try {
    assert.equal((await s.call('PUT', '/api/db', { body: doc({ rev: 0 }) })).json.rev, 1);
    const stale = await s.call('PUT', '/api/db', { body: doc({ rev: 0 }) });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.db.rev, 1);
    assert.equal((await s.call('PUT', '/api/db', { body: doc({ rev: 1 }) })).json.rev, 2);
  } finally { await s.close(); }
});

test('the allowlist blocks other accounts at sign-in and on every request', async () => {
  const s = await start({ allow: 'me@example.com' });
  try {
    const refused = await s.login('222', 'stranger@example.com');
    assert.equal(refused.status, 403);
    assert.equal(refused.json.token, undefined);
    // A token minted for an email that is no longer allowed stops working immediately.
    const stale = s.sessions.issue({ sub: '222', email: 'stranger@example.com', name: 'S' });
    assert.equal((await s.call('GET', '/api/db', { token: stale })).status, 403);
  } finally { await s.close(); }
});

test('without an allowlist anyone can sign in, but each account sees only its own data', async () => {
  const s = await start({ allow: '' });
  try {
    const a = (await s.login('111', 'a@example.com')).json.token;
    const b = (await s.login('222', 'b@example.com')).json.token;
    await s.call('PUT', '/api/db', { token: a, body: doc() });
    assert.equal((await s.call('GET', '/api/db', { token: b })).json.accounts.length, 0);
    assert.equal((await s.call('GET', '/api/db', { token: a })).json.accounts.length, 1);
  } finally { await s.close(); }
});

test('the first allow-listed sign-in takes over pre-sign-in data, exactly once', async () => {
  const s = await start({ allow: 'me@example.com, spouse@example.com' });
  try {
    fs.writeFileSync(path.join(s.dataDir, 'db.json'), JSON.stringify(doc({ rev: 7 })));
    const me = (await s.login('111', 'me@example.com')).json.token;
    assert.equal((await s.call('GET', '/api/db', { token: me })).json.rev, 7);
    assert.ok(!fs.existsSync(path.join(s.dataDir, 'db.json')));
    assert.ok(fs.existsSync(path.join(s.dataDir, 'db.claimed-by-111.json')));
    const spouse = (await s.login('222', 'spouse@example.com')).json.token;
    assert.equal((await s.call('GET', '/api/db', { token: spouse })).json.rev, 0);
  } finally { await s.close(); }
});

test('with an open sign-in (no allowlist), pre-sign-in data is never handed to anyone', async () => {
  const s = await start({ allow: '' });
  try {
    fs.writeFileSync(path.join(s.dataDir, 'db.json'), JSON.stringify(doc({ rev: 7 })));
    const t = (await s.login('333', 'random@example.com')).json.token;
    assert.equal((await s.call('GET', '/api/db', { token: t })).json.rev, 0);
    assert.ok(fs.existsSync(path.join(s.dataDir, 'db.json')));
  } finally { await s.close(); }
});

test('rejects bad request bodies and keeps static files inside public/', async () => {
  const s = await start({ signIn: false });
  try {
    assert.equal((await s.call('PUT', '/api/db', { body: 'x', type: 'text/plain' })).status, 415);
    assert.equal((await s.call('PUT', '/api/db', { body: '{nope' })).status, 400);
    assert.equal((await s.call('PUT', '/api/db', { body: { accounts: 'no' } })).status, 400);
    const page = await s.call('GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.text, /GiveMeBucks/);
    for (const p of ['/..%2fserver.js', '/%2e%2e/server.js', '/js/../../server.js']) {
      assert.notEqual((await s.call('GET', p)).status, 200, p);
    }
  } finally { await s.close(); }
});
