// Storage contract: files on the Mac, Neon Postgres in the cloud. The Neon
// backend runs against a small in-memory fake of the four statements it uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileStorage, neonStorage, createStorage, databaseUrl } from '../lib/storage.js';

const doc = (rev, extra = {}) => ({ rev, accounts: [{ id: 'a' }], snapshots: [], income: [], settings: {}, ...extra });

/** Mimics @neondatabase/serverless's sql.query(text, params) → rows for our statements. */
function fakeNeon({ jsonAsText = false } = {}) {
  const table = new Map();
  const calls = { schema: 0, queries: [] };
  const sql = {
    async query(text, params) {
      const q = text.replace(/\s+/g, ' ').trim();
      calls.queries.push(q);
      if (q.startsWith('CREATE TABLE IF NOT EXISTS givemebucks_user_data')) { calls.schema++; return []; }
      if (q.startsWith('SELECT data, rev FROM')) {
        const row = table.get(params[0]);
        return row ? [{ data: jsonAsText ? JSON.stringify(row.data) : row.data, rev: row.rev }] : [];
      }
      if (q.startsWith('INSERT INTO')) {
        if (table.has(params[0])) return [];
        table.set(params[0], { data: JSON.parse(params[1]), rev: params[2] });
        return [{ rev: params[2] }];
      }
      if (q.startsWith('UPDATE')) {
        const row = table.get(params[0]);
        if (!row || row.rev !== params[3]) return [];
        table.set(params[0], { data: JSON.parse(params[1]), rev: params[2] });
        return [{ rev: params[2] }];
      }
      if (q.startsWith('SELECT user_id FROM')) return [...table.keys()].sort().map((user_id) => ({ user_id }));
      throw new Error(`unexpected query: ${q}`);
    },
  };
  return { sql, table, calls };
}

for (const [name, make] of [
  ['file', () => fileStorage(fs.mkdtempSync(path.join(os.tmpdir(), 'gmb-store-')))],
  ['neon', () => neonStorage('postgres://fake', { connect: () => fakeNeon().sql })],
]) {
  test(`${name} storage: empty account, first save, update, stale save`, async () => {
    const store = make();
    assert.deepEqual(await store.read('u1'), { rev: 0, accounts: [], snapshots: [], income: [], settings: {}, meta: {} });

    assert.deepEqual(await store.write('u1', doc(1), 0), { ok: true, rev: 1 });
    assert.equal((await store.read('u1')).rev, 1);
    assert.equal((await store.read('u1')).accounts[0].id, 'a');

    assert.deepEqual(await store.write('u1', doc(2), 1), { ok: true, rev: 2 });
    const stale = await store.write('u1', doc(2, { accounts: [] }), 1);
    assert.equal(stale.ok, false);
    assert.equal(stale.current.rev, 2);
    assert.equal(stale.current.accounts.length, 1, 'stale write did not land');

    const dupFirst = await store.write('u1', doc(1), 0);
    assert.equal(dupFirst.ok, false, 'a second "first save" is a conflict too');

    assert.deepEqual(await store.write('u2', doc(1), 0), { ok: true, rev: 1 });
    assert.equal((await store.read('u1')).rev, 2, 'accounts are independent');
  });
}

test('neon storage: creates the table once, lists accounts, parses JSON text', async () => {
  const fake = fakeNeon({ jsonAsText: true });
  const store = neonStorage('postgres://fake', { connect: () => fake.sql });
  await store.write('b', doc(1), 0);
  await store.write('a', doc(1), 0);
  assert.equal((await store.read('a')).accounts[0].id, 'a');
  assert.deepEqual(await store.listUserIds(), ['a', 'b']);
  assert.equal(fake.calls.schema, 1);
  assert.equal(await store.claimLegacy('a'), false);
  // The stored JSON never duplicates rev; the rev column is the source of truth.
  assert.equal(fake.table.get('a').data.rev, undefined);
});

test('neon storage: a failed connection is retried on the next call', async () => {
  let attempts = 0;
  const fake = fakeNeon();
  const store = neonStorage('postgres://fake', {
    connect: () => ({ query: (t, p) => (++attempts === 1 ? Promise.reject(new Error('cold start')) : fake.sql.query(t, p)) }),
  });
  await assert.rejects(store.read('x'), /cold start/);
  assert.equal((await store.read('x')).rev, 0);
});

test('storage is chosen by DATABASE_URL or POSTGRES_URL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmb-pick-'));
  assert.equal(createStorage({ env: {}, dataDir: dir }).kind, 'file');
  assert.equal(createStorage({ env: { DATABASE_URL: 'postgres://x' }, dataDir: dir }).kind, 'database');
  assert.equal(databaseUrl({ POSTGRES_URL: ' postgres://y ' }), 'postgres://y');
});
