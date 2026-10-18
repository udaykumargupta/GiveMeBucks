// Storage contract: files on the Mac, Neon Postgres in the cloud. v2 documents
// live apart from v1, which is only ever read. The Neon backend runs against a
// small in-memory fake of the statements it uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileStorage, neonStorage, createStorage, databaseUrl } from '../lib/storage.js';
import { claimLegacy } from '../lib/store.js';

const doc = (rev, extra = {}) => ({ version: 2, rev, places: [{ id: 'a', name: 'HDFC', type: 'bank', createdOn: '2026-10-01' }], entries: [], ...extra });
const v1 = { rev: 7, accounts: [{ id: 'a', name: 'SBI', kind: 'bank' }], snapshots: [], income: [], settings: {}, meta: {} };

/** Mimics @neondatabase/serverless's sql.query(text, params) → rows for our statements. */
function fakeNeon({ jsonAsText = false, v1Rows = {}, v1Table = true } = {}) {
  const table = new Map();
  const calls = { schema: 0, queries: [] };
  const sql = {
    async query(text, params) {
      const q = text.replace(/\s+/g, ' ').trim();
      calls.queries.push(q);
      if (q.startsWith('CREATE TABLE IF NOT EXISTS givemebucks_v2 ')) { calls.schema++; return []; }
      if (q.startsWith('SELECT data, rev FROM givemebucks_v2 WHERE')) {
        const row = table.get(params[0]);
        return row ? [{ data: jsonAsText ? JSON.stringify(row.data) : row.data, rev: row.rev }] : [];
      }
      if (q.startsWith('SELECT data, rev FROM givemebucks_user_data WHERE')) {
        if (!v1Table) throw Object.assign(new Error('relation "givemebucks_user_data" does not exist'), { code: '42P01' });
        const row = v1Rows[params[0]];
        return row ? [{ data: jsonAsText ? JSON.stringify(row.data) : row.data, rev: row.rev }] : [];
      }
      if (q.startsWith('INSERT INTO givemebucks_v2 ')) {
        if (table.has(params[0])) return [];
        table.set(params[0], { data: JSON.parse(params[1]), rev: params[2] });
        return [{ rev: params[2] }];
      }
      if (q.startsWith('UPDATE givemebucks_v2 ')) {
        const row = table.get(params[0]);
        if (!row || row.rev !== params[3]) return [];
        table.set(params[0], { data: JSON.parse(params[1]), rev: params[2] });
        return [{ rev: params[2] }];
      }
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
    assert.equal(await store.read('u1'), null, 'no document → null (no v1 empty default)');
    assert.equal(await store.readV1('u1'), null);
    assert.equal('listUserIds' in store, false);

    assert.deepEqual(await store.write('u1', doc(1), 0), { ok: true, rev: 1 });
    assert.equal((await store.read('u1')).rev, 1);
    assert.equal((await store.read('u1')).places[0].id, 'a');

    assert.deepEqual(await store.write('u1', doc(2), 1), { ok: true, rev: 2 });
    const stale = await store.write('u1', doc(2, { places: [] }), 1);
    assert.equal(stale.ok, false);
    assert.equal(stale.current.rev, 2);
    assert.equal(stale.current.places.length, 1, 'stale write did not land');

    const dupFirst = await store.write('u1', doc(1), 0);
    assert.equal(dupFirst.ok, false, 'a second "first save" is a conflict too');
    assert.equal(dupFirst.current.rev, 2);

    const noDoc = await store.write('u3', doc(5), 4);
    assert.equal(noDoc.ok, false, 'an update needs an existing document');

    assert.deepEqual(await store.write('u2', doc(1), 0), { ok: true, rev: 1 });
    assert.equal((await store.read('u1')).rev, 2, 'accounts are independent');
    assert.equal(await store.readV1('u1'), null, 'v2 saves never write v1');
  });
}

test('file storage: v2 lives in db.v2.json / users/<id>.v2.json; v1 files are read but never written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmb-files-'));
  const store = fileStorage(dir);
  fs.mkdirSync(path.join(dir, 'users'));
  const v1Text = JSON.stringify(v1);
  fs.writeFileSync(path.join(dir, 'db.json'), v1Text);
  fs.writeFileSync(path.join(dir, 'users', '111.json'), v1Text);

  assert.deepEqual(await store.readV1('local'), v1);
  assert.deepEqual(await store.readV1('111'), v1);
  assert.equal(await store.read('local'), null, 'a v1 file is not a v2 document');

  await store.write('local', doc(1), 0);
  await store.write('111', doc(1), 0);
  await store.write('111', doc(2), 1);
  assert.ok(fs.existsSync(path.join(dir, 'db.v2.json')));
  assert.ok(fs.existsSync(path.join(dir, 'users', '111.v2.json')));
  assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), v1Text, 'v1 byte-identical');
  assert.equal(fs.readFileSync(path.join(dir, 'users', '111.json'), 'utf8'), v1Text, 'v1 byte-identical');
  assert.ok(fs.existsSync(path.join(dir, 'users', 'backups', '111.v2-' + new Date().toISOString().slice(0, 10) + '.json')), 'daily backup of the v2 file');
});

test('claimLegacy moves the v1 and v2 files when present, never over an existing one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmb-claim-'));
  const v1Text = JSON.stringify(v1);
  const v2Text = JSON.stringify(doc(3));
  fs.writeFileSync(path.join(dir, 'db.json'), v1Text);
  fs.writeFileSync(path.join(dir, 'db.v2.json'), v2Text);

  assert.equal(claimLegacy(dir, '111'), true);
  assert.equal(fs.readFileSync(path.join(dir, 'users', '111.json'), 'utf8'), v1Text);
  assert.equal(fs.readFileSync(path.join(dir, 'users', '111.v2.json'), 'utf8'), v2Text);
  assert.ok(!fs.existsSync(path.join(dir, 'db.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'db.v2.json')));
  assert.ok(fs.existsSync(path.join(dir, 'db.claimed-by-111.json')));
  assert.ok(fs.existsSync(path.join(dir, 'db.v2.claimed-by-111.json')));
  assert.equal(claimLegacy(dir, '222'), false, 'only once');

  // Only the v1 file present, and the user already has a v2 file: only v1 moves.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gmb-claim-'));
  fs.mkdirSync(path.join(dir2, 'users'));
  fs.writeFileSync(path.join(dir2, 'db.json'), v1Text);
  fs.writeFileSync(path.join(dir2, 'db.v2.json'), v2Text);
  fs.writeFileSync(path.join(dir2, 'users', '111.v2.json'), '{"mine":true}');
  assert.equal(claimLegacy(dir2, '111'), true);
  assert.equal(fs.readFileSync(path.join(dir2, 'users', '111.v2.json'), 'utf8'), '{"mine":true}', 'never overwritten');
  assert.ok(fs.existsSync(path.join(dir2, 'db.v2.json')), 'the unclaimed original stays');
  assert.ok(fs.existsSync(path.join(dir2, 'users', '111.json')));
});

test('R17 · claimLegacy leaves db.v2.json alone when the user already has their own v1 file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmb-claim-'));
  fs.mkdirSync(path.join(dir, 'users'));
  fs.writeFileSync(path.join(dir, 'users', '111.json'), JSON.stringify(v1));
  fs.writeFileSync(path.join(dir, 'db.v2.json'), JSON.stringify(doc(1)));
  assert.equal(claimLegacy(dir, '111'), false);
  assert.ok(fs.existsSync(path.join(dir, 'db.v2.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'users', '111.v2.json')));
  // With db.json present too, the user's own v1 file wins and nothing local is moved.
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ ...v1, rev: 9 }));
  assert.equal(claimLegacy(dir, '111'), false);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['db.json', 'db.v2.json', 'users']);
});

test('neon storage: creates only the v2 table, once; reads v1 from givemebucks_user_data; parses JSON text', async () => {
  const fake = fakeNeon({ jsonAsText: true, v1Rows: { a: { data: { accounts: [{ id: 'x' }], snapshots: [], income: [] }, rev: 7 } } });
  const store = neonStorage('postgres://fake', { connect: () => fake.sql });
  await store.write('b', doc(1), 0);
  await store.write('a', doc(1), 0);
  assert.equal((await store.read('a')).places[0].id, 'a');
  assert.deepEqual(await store.readV1('a'), { accounts: [{ id: 'x' }], snapshots: [], income: [], rev: 7 });
  assert.equal(await store.readV1('b'), null);
  assert.equal(fake.calls.schema, 1);
  assert.equal(await store.claimLegacy('a'), false);
  // The stored JSON never duplicates rev; the rev column is the source of truth.
  assert.equal(fake.table.get('a').data.rev, undefined);
  // v1 is only ever SELECTed.
  const v1Statements = fake.calls.queries.filter((q) => q.includes('givemebucks_user_data'));
  assert.ok(v1Statements.length > 0);
  assert.ok(v1Statements.every((q) => q.startsWith('SELECT ')), v1Statements.join('\n'));
  assert.ok(fake.calls.queries.filter((q) => /^(INSERT|UPDATE)/.test(q)).every((q) => /^(INSERT INTO|UPDATE) givemebucks_v2 /.test(q)));
});

test('neon storage: a database that never had the v1 table reads v1 as null', async () => {
  const store = neonStorage('postgres://fake', { connect: () => fakeNeon({ v1Table: false }).sql });
  assert.equal(await store.readV1('a'), null);
});

test('neon storage: a failed connection is retried on the next call', async () => {
  let attempts = 0;
  const fake = fakeNeon();
  const store = neonStorage('postgres://fake', {
    connect: () => ({ query: (t, p) => (++attempts === 1 ? Promise.reject(new Error('cold start')) : fake.sql.query(t, p)) }),
  });
  await assert.rejects(store.read('x'), /cold start/);
  assert.equal(await store.read('x'), null);
});

test('storage is chosen by DATABASE_URL or POSTGRES_URL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmb-pick-'));
  assert.equal(createStorage({ env: {}, dataDir: dir }).kind, 'file');
  assert.equal(createStorage({ env: { DATABASE_URL: 'postgres://x' }, dataDir: dir }).kind, 'database');
  assert.equal(databaseUrl({ POSTGRES_URL: ' postgres://y ' }), 'postgres://y');
});
