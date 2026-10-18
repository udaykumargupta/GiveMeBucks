// End-to-end tests of the HTTP API (lib/app.js) with a stubbed Google verifier.
// `today` is injected as 2026-10-18 (spec §8.8).
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

const TODAY = '2026-10-18';
const NOW = '2026-10-18T09:30:00.000Z';
const OUTDATED = { code: 'outdated_client', error: 'GiveMeBucks was updated — reload the page.' };

async function start({ signIn = true, allow = '' } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmb-test-'));
  const sessions = createSessions({ secret: 's'.repeat(48) });
  const auth = signIn
    ? { enabled: true, clientId: 'client-123', allow: parseAllowlist(allow), sessions, verifyGoogle: fakeGoogle }
    : { enabled: false, allow: new Set() };
  const handler = createHandler({ publicDir: PUBLIC, auth, storage: fileStorage(dataDir), log: quiet, today: () => TODAY, now: () => new Date(NOW) });
  const server = http.createServer(handler);
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
  const file = (...p) => path.join(dataDir, ...p);
  return { dataDir, sessions, call, login, close, file };
}

// A small valid v2 document: HDFC with a starting balance.
const doc = (extra = {}) => ({
  version: 2, rev: 0,
  places: [{ id: 'hdfc', name: 'HDFC', type: 'bank', createdOn: '2026-10-01' }],
  entries: [{ id: 'e1', kind: 'set', placeId: 'hdfc', date: '2026-10-01', amount: 50000, seq: 1, baseline: true }],
  ...extra,
});
// The owner's single-bank v1 document at rev 7 (same shape as data/db.json; data/ itself is never read).
const ownerV1 = () => ({
  rev: 7, savedAt: '2026-10-17T10:00:00.000Z',
  accounts: [{ id: 'a559a649aa0d', name: 'SBI', kind: 'bank' }],
  snapshots: [{ id: 'c026fa46b6b7', accountId: 'a559a649aa0d', date: '2026-10-17', value: 10000 }],
  income: [], settings: {}, meta: {},
});
const v1Body = () => ({ rev: 0, accounts: [{ id: 'a', name: 'HDFC', kind: 'bank' }], snapshots: [], income: [], settings: {} });

test('S1/S3 · local mode works without sign-in; a fresh GET is an empty v2 doc and writes nothing', async () => {
  const s = await start({ signIn: false });
  try {
    assert.deepEqual((await s.call('GET', '/api/public/config')).json, { googleClientId: null, authRequired: false, restricted: false, storage: 'file', setupMissing: [] });
    const fresh = await s.call('GET', '/api/db');
    assert.equal(fresh.status, 200);
    assert.deepEqual(fresh.json, { version: 2, rev: 0, places: [], entries: [] });
    assert.deepEqual(fs.readdirSync(s.dataDir), [], 'no file written');

    const saved = await s.call('PUT', '/api/db', { body: doc() });
    assert.deepEqual(saved.json, { rev: 1, savedAt: NOW });
    assert.ok(fs.existsSync(s.file('db.v2.json')));
    assert.ok(!fs.existsSync(s.file('db.json')), 'v2 never writes the v1 file');
    const back = (await s.call('GET', '/api/db')).json;
    assert.deepEqual(back, { ...doc(), rev: 1, savedAt: NOW });
    assert.equal((await s.call('POST', '/api/auth/google', { body: { idToken: 'good:1:a@example.com' } })).status, 400);
  } finally { await s.close(); }
});

test('S4 · the first GET migrates the v1 db.json into db.v2.json; v1 stays byte-identical; the second GET does not write', async () => {
  const s = await start({ signIn: false });
  try {
    const v1Text = JSON.stringify(ownerV1(), null, 2);
    fs.writeFileSync(s.file('db.json'), v1Text);
    const first = await s.call('GET', '/api/db');
    assert.equal(first.status, 200);
    assert.equal(first.json.version, 2);
    assert.equal(first.json.rev, 1);
    assert.equal(first.json.savedAt, NOW);
    assert.deepEqual(first.json.places, [{ id: 'a559a649aa0d', name: 'SBI', type: 'bank', createdOn: '2026-10-17' }]);
    assert.equal(fs.readFileSync(s.file('db.json'), 'utf8'), v1Text, 'db.json byte-identical');

    const stored = JSON.parse(fs.readFileSync(s.file('db.v2.json'), 'utf8'));
    const { rev, savedAt, ...v1Rest } = ownerV1();
    assert.deepEqual(stored.legacyV1.doc, v1Rest);
    assert.equal(stored.legacyV1.migratedAt, NOW);
    assert.equal(stored.rev, 1);

    const before = fs.statSync(s.file('db.v2.json')).mtimeMs;
    const second = await s.call('GET', '/api/db');
    assert.equal(second.json.rev, 1);
    assert.deepEqual(second.json, first.json);
    assert.equal(fs.statSync(s.file('db.v2.json')).mtimeMs, before, 'no second write');
    assert.ok(!fs.existsSync(path.join(s.dataDir, 'backups')) || fs.readdirSync(path.join(s.dataDir, 'backups')).length === 0, 'nothing to back up yet');
    assert.equal(fs.readFileSync(s.file('db.json'), 'utf8'), v1Text);
  } finally { await s.close(); }
});

test('an empty v1 document gives the empty v2 doc without writing', async () => {
  const s = await start({ signIn: false });
  try {
    fs.writeFileSync(s.file('db.json'), JSON.stringify({ rev: 0, accounts: [], snapshots: [], income: [], settings: {}, meta: {} }));
    assert.deepEqual((await s.call('GET', '/api/db')).json, { version: 2, rev: 0, places: [], entries: [] });
    assert.ok(!fs.existsSync(s.file('db.v2.json')));
  } finally { await s.close(); }
});

test('a v1 document that cannot be migrated → 500 migration_failed, nothing written', async () => {
  const s = await start({ signIn: false });
  try {
    const broken = JSON.stringify({ version: 2, places: 'oops', entries: [] });
    fs.writeFileSync(s.file('db.json'), broken);
    const res = await s.call('GET', '/api/db');
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, { code: 'migration_failed', error: "Couldn't upgrade your data — nothing was changed." });
    assert.ok(!fs.existsSync(s.file('db.v2.json')));
    assert.equal(fs.readFileSync(s.file('db.json'), 'utf8'), broken);
    // The untouched v1 data is still downloadable.
    assert.deepEqual((await s.call('GET', '/api/db/v1')).json, JSON.parse(broken));
  } finally { await s.close(); }
});

test('S5 · GET /api/db/v1 returns the untouched v1 document, or 404', async () => {
  const s = await start({ signIn: false });
  try {
    const none = await s.call('GET', '/api/db/v1');
    assert.equal(none.status, 404);
    assert.equal(none.json.code, 'not_found');
    fs.writeFileSync(s.file('db.json'), JSON.stringify(ownerV1()));
    await s.call('GET', '/api/db'); // migrates
    const v1 = await s.call('GET', '/api/db/v1');
    assert.equal(v1.status, 200);
    assert.deepEqual(v1.json, ownerV1());
  } finally { await s.close(); }
});

test('S6 · a v1-shaped PUT is refused as outdated_client and writes nothing', async () => {
  const s = await start({ signIn: false });
  try {
    const res = await s.call('PUT', '/api/db', { body: v1Body() });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, OUTDATED);
    assert.deepEqual(fs.readdirSync(s.dataDir), []);
  } finally { await s.close(); }
});

test('S7 · an invalid v2 PUT → 400 invalid with the failing path', async () => {
  const s = await start({ signIn: false });
  try {
    const early = doc({ entries: [{ id: 'x1', kind: 'add', placeId: 'hdfc', date: '2026-09-30', amount: 100, seq: 1 }] });
    const res = await s.call('PUT', '/api/db', { body: early });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'invalid');
    assert.equal(res.json.path, 'entries[0].date');
    assert.match(res.json.error, /^entries\[0\]\.date: /);

    const future = await s.call('PUT', '/api/db', { body: doc({ entries: [{ id: 'x1', kind: 'add', placeId: 'hdfc', date: '2026-10-20', amount: 100, seq: 1 }] }) });
    assert.equal(future.json.path, 'entries[0].date', 'today (IST) + 1 is the limit');
    assert.equal((await s.call('PUT', '/api/db', { body: doc({ entries: [{ id: 'x1', kind: 'add', placeId: 'hdfc', date: '2026-10-19', amount: 100, seq: 1 }] }) })).status, 200);

    assert.equal((await s.call('PUT', '/api/db', { body: doc({ recurring: [] }) })).json.path, 'recurring', 'monthly rules are not part of v2');
    assert.ok(!fs.readFileSync(s.file('db.v2.json'), 'utf8').includes('recurring'));
  } finally { await s.close(); }
});

test('S8 · a save from a stale tab is refused with the latest v2 data', async () => {
  const s = await start({ signIn: false });
  try {
    assert.equal((await s.call('PUT', '/api/db', { body: doc({ rev: 0 }) })).json.rev, 1);
    const stale = await s.call('PUT', '/api/db', { body: doc({ rev: 0 }) });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, 'conflict');
    assert.equal(typeof stale.json.error, 'string');
    assert.equal(stale.json.db.version, 2);
    assert.equal(stale.json.db.rev, 1);
    assert.equal((await s.call('PUT', '/api/db', { body: doc({ rev: 1 }) })).json.rev, 2);
  } finally { await s.close(); }
});

test('a first save while unmigrated v1 data exists migrates it first and conflicts, so v1 data is never hidden', async () => {
  const s = await start({ signIn: false });
  try {
    fs.writeFileSync(s.file('db.json'), JSON.stringify(ownerV1()));
    const res = await s.call('PUT', '/api/db', { body: doc({ rev: 0 }) });
    assert.equal(res.status, 409);
    assert.equal(res.json.db.rev, 1);
    assert.equal(res.json.db.places[0].name, 'SBI');
  } finally { await s.close(); }
});

test('S9 · a PUT without legacyV1 keeps the stored one; a PUT with one replaces it', async () => {
  const s = await start({ signIn: false });
  try {
    fs.writeFileSync(s.file('db.json'), JSON.stringify(ownerV1()));
    const migrated = (await s.call('GET', '/api/db')).json;
    const { legacyV1, savedAt, ...edited } = migrated;
    edited.places = [...edited.places, { id: 'cash', name: 'Cash', type: 'cash', createdOn: '2026-10-18' }];
    assert.equal((await s.call('PUT', '/api/db', { body: edited })).json.rev, 2);
    const after = (await s.call('GET', '/api/db')).json;
    assert.equal(after.places.length, 2);
    assert.deepEqual(after.legacyV1, legacyV1);

    const replaced = { ...after, legacyV1: { note: 'imported' } };
    assert.equal((await s.call('PUT', '/api/db', { body: replaced })).json.rev, 3);
    assert.deepEqual((await s.call('GET', '/api/db')).json.legacyV1, { note: 'imported' });
  } finally { await s.close(); }
});

test('S11 · the reminder and due routes are gone', async () => {
  const s = await start({ signIn: false });
  try {
    assert.equal((await s.call('GET', '/api/due')).status, 404);
    assert.equal((await s.call('POST', '/api/reminder/test')).status, 404);
    assert.equal((await s.call('GET', '/api/reminder/status')).status, 404);
  } finally { await s.close(); }
});

test('with sign-in on, the API needs a valid session token', async () => {
  const s = await start({ allow: 'me@example.com' });
  try {
    assert.deepEqual((await s.call('GET', '/api/public/config')).json, { googleClientId: 'client-123', authRequired: true, restricted: true, storage: 'file', setupMissing: [] });
    const anon = await s.call('GET', '/api/db');
    assert.equal(anon.status, 401);
    assert.deepEqual(anon.json, { error: 'unauthorized', message: 'Authentication required' });
    assert.equal((await s.call('GET', '/api/db', { token: 'not.a.token' })).status, 401);
    assert.equal((await s.call('GET', '/api/db/v1')).status, 401);
    assert.equal((await s.call('POST', '/api/auth/google', { body: { idToken: 'bad' } })).status, 401);

    const ok = await s.login('111', 'me@example.com');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.user, { email: 'me@example.com', name: 'Test User', picture: '' });
    const token = ok.json.token;
    assert.equal((await s.call('GET', '/api/me', { token })).json.email, 'me@example.com');
    assert.equal((await s.call('PUT', '/api/db', { token, body: doc() })).json.rev, 1);
    assert.equal((await s.call('GET', '/api/db', { token })).json.places[0].name, 'HDFC');
    assert.ok(fs.existsSync(s.file('users', '111.v2.json')), 'stored per user');
    assert.ok(!fs.existsSync(s.file('users', '111.json')), 'never as v1');
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
    assert.equal((await s.call('GET', '/api/db', { token: b })).json.places.length, 0);
    assert.equal((await s.call('GET', '/api/db', { token: a })).json.places.length, 1);
  } finally { await s.close(); }
});

test('S14 · the first allow-listed sign-in takes over pre-sign-in data (v1 and v2), exactly once', async () => {
  const s = await start({ allow: 'me@example.com, spouse@example.com' });
  try {
    const v1Text = JSON.stringify(ownerV1());
    fs.writeFileSync(s.file('db.json'), v1Text);
    const me = (await s.login('111', 'me@example.com')).json.token;
    assert.ok(!fs.existsSync(s.file('db.json')));
    assert.ok(fs.existsSync(s.file('db.claimed-by-111.json')));
    assert.equal(fs.readFileSync(s.file('users', '111.json'), 'utf8'), v1Text);
    const mine = (await s.call('GET', '/api/db', { token: me })).json;
    assert.equal(mine.rev, 1, 'migrated on first read');
    assert.equal(mine.places[0].name, 'SBI');
    assert.equal(fs.readFileSync(s.file('users', '111.json'), 'utf8'), v1Text, 'v1 untouched');
    const spouse = (await s.login('222', 'spouse@example.com')).json.token;
    assert.equal((await s.call('GET', '/api/db', { token: spouse })).json.rev, 0);
  } finally { await s.close(); }
});

test('S14 · a local v2 document (db.v2.json) moves too', async () => {
  const s = await start({ allow: 'me@example.com' });
  try {
    fs.writeFileSync(s.file('db.v2.json'), JSON.stringify({ ...doc(), rev: 4 }));
    const me = (await s.login('111', 'me@example.com')).json.token;
    assert.ok(fs.existsSync(s.file('users', '111.v2.json')));
    assert.ok(fs.existsSync(s.file('db.v2.claimed-by-111.json')));
    assert.equal((await s.call('GET', '/api/db', { token: me })).json.rev, 4);
  } finally { await s.close(); }
});

test('R17 · a local db.v2.json never hides an account\'s own v1 data', async () => {
  const s = await start({ allow: 'me@example.com' });
  try {
    fs.mkdirSync(s.file('users'));
    fs.writeFileSync(s.file('users', '111.json'), JSON.stringify(ownerV1()));
    fs.writeFileSync(s.file('db.v2.json'), JSON.stringify({ ...doc(), places: [{ id: 'cash', name: 'Cash', type: 'cash', createdOn: '2026-10-01' }], entries: [], rev: 1 }));
    const me = (await s.login('111', 'me@example.com')).json.token;
    const mine = (await s.call('GET', '/api/db', { token: me })).json;
    assert.deepEqual(mine.places.map((p) => p.name), ['SBI'], 'migrated from the account\'s own v1 file');
    assert.ok(mine.legacyV1);
    assert.ok(fs.existsSync(s.file('db.v2.json')), 'the local v2 document stays unclaimed');
    assert.ok(!fs.existsSync(s.file('db.v2.claimed-by-111.json')));
  } finally { await s.close(); }
});

test('with an open sign-in (no allowlist), pre-sign-in data is never handed to anyone', async () => {
  const s = await start({ allow: '' });
  try {
    fs.writeFileSync(s.file('db.json'), JSON.stringify(ownerV1()));
    fs.writeFileSync(s.file('db.v2.json'), JSON.stringify({ ...doc(), rev: 4 }));
    const t = (await s.login('333', 'random@example.com')).json.token;
    assert.equal((await s.call('GET', '/api/db', { token: t })).json.rev, 0);
    assert.equal((await s.call('GET', '/api/db/v1', { token: t })).status, 404);
    assert.ok(fs.existsSync(s.file('db.json')));
    assert.ok(fs.existsSync(s.file('db.v2.json')));
  } finally { await s.close(); }
});

test('rejects bad request bodies and keeps static files inside public/', async () => {
  const s = await start({ signIn: false });
  try {
    const plain = await s.call('PUT', '/api/db', { body: 'x', type: 'text/plain' });
    assert.equal(plain.status, 415);
    assert.equal(plain.json.code, 'bad_request');
    const malformed = await s.call('PUT', '/api/db', { body: '{nope' });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.code, 'bad_request');
    const shape = await s.call('PUT', '/api/db', { body: { accounts: 'no' } });
    assert.equal(shape.status, 400);
    assert.equal(shape.json.code, 'invalid');
    assert.equal((await s.call('PUT', '/api/db', { body: [] })).json.code, 'invalid');
    assert.equal((await s.call('PUT', '/api/db', { body: 'x'.repeat(5 * 1024 * 1024) })).status, 413);
    const page = await s.call('GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.text, /GiveMeBucks/);
    for (const p of ['/..%2flocal-server.js', '/%2e%2e/local-server.js', '/js/../../local-server.js']) {
      assert.notEqual((await s.call('GET', p)).status, 200, p);
    }
  } finally { await s.close(); }
});
