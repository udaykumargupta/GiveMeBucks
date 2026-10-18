// Where account data lives. JSON files on this Mac by default; Neon Postgres
// when DATABASE_URL (or POSTGRES_URL, as Vercel's Neon integration names it)
// is set — required on Vercel, optional locally.
//
// v2 documents live apart from v1 (table givemebucks_v2, files *.v2.json), so
// the v1 data stays untouched and a v1 build can still be redeployed.
//
// Contract (all async):
//   read(id)                       → the account's v2 document (with rev), or null
//   readV1(id)                     → the untouched v1 document, or null (never written)
//   write(id, next, expectedRev)   → { ok: true, rev } | { ok: false, current }
//                                    (saves only if nobody saved since expectedRev;
//                                     expectedRev 0 = create only if absent)
//   claimLegacy(id)                → moves pre-sign-in data to id (files only)
import { legacyStore, userStore, legacyStoreV2, userStoreV2, claimLegacy } from './store.js';

export const databaseUrl = (env = process.env) => String(env.DATABASE_URL || env.POSTGRES_URL || '').trim();

export function fileStorage(dataDir) {
  const v2For = (id) => (id === 'local' ? legacyStoreV2(dataDir) : userStoreV2(dataDir, id));
  const v1For = (id) => (id === 'local' ? legacyStore(dataDir) : userStore(dataDir, id));
  return {
    kind: 'file',
    async read(id) {
      return v2For(id).read();
    },
    async readV1(id) {
      return v1For(id).read();
    },
    async write(id, next, expectedRev) {
      const store = v2For(id);
      const current = store.read();
      const fits = expectedRev === 0 ? !current : !!current && current.rev === expectedRev;
      if (!fits) return { ok: false, current };
      store.write(next);
      return { ok: true, rev: next.rev };
    },
    async claimLegacy(id) {
      return claimLegacy(dataDir, id);
    },
  };
}

// The v1 table (givemebucks_user_data) is only ever SELECTed, never created or written.
const SCHEMA = `CREATE TABLE IF NOT EXISTS givemebucks_v2 (
  user_id    text PRIMARY KEY,
  data       jsonb NOT NULL,
  rev        integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;
const UNDEFINED_TABLE = '42P01';

/** connect(url) → { query(text, params) → rows } — injectable for tests. */
export function neonStorage(url, { connect } = {}) {
  let ready = null;
  const db = () => (ready ||= (async () => {
    const sql = connect ? connect(url) : (await import('@neondatabase/serverless')).neon(url);
    await sql.query(SCHEMA); // creates the table on first use
    return sql;
  })().catch((err) => { ready = null; throw err; }));

  const parse = (data) => (typeof data === 'string' ? JSON.parse(data) : data);
  const docOf = (rows) => (rows.length ? { ...parse(rows[0].data), rev: rows[0].rev } : null);

  async function read(id) {
    return docOf(await (await db()).query('SELECT data, rev FROM givemebucks_v2 WHERE user_id = $1', [id]));
  }

  return {
    kind: 'database',
    read,
    async readV1(id) {
      const sql = await db();
      try {
        return docOf(await sql.query('SELECT data, rev FROM givemebucks_user_data WHERE user_id = $1', [id]));
      } catch (err) {
        if (err?.code === UNDEFINED_TABLE) return null; // a database that never ran v1
        throw err;
      }
    },
    async write(id, next, expectedRev) {
      const sql = await db();
      const { rev, ...data } = next;
      // Compare-and-set in one statement: the save lands only if the stored rev
      // is still the one the browser loaded (or, for a first save, no row yet).
      const rows = expectedRev === 0
        ? await sql.query('INSERT INTO givemebucks_v2 (user_id, data, rev) VALUES ($1, $2::jsonb, $3) ON CONFLICT (user_id) DO NOTHING RETURNING rev', [id, JSON.stringify(data), rev])
        : await sql.query('UPDATE givemebucks_v2 SET data = $2::jsonb, rev = $3, updated_at = now() WHERE user_id = $1 AND rev = $4 RETURNING rev', [id, JSON.stringify(data), rev, expectedRev]);
      if (rows.length) return { ok: true, rev: rows[0].rev };
      return { ok: false, current: await read(id) };
    },
    async claimLegacy() {
      return false; // nothing on disk in the cloud; import a backup instead
    },
  };
}

export function createStorage({ env = process.env, dataDir }) {
  const url = databaseUrl(env);
  return url ? neonStorage(url) : fileStorage(dataDir);
}
