// Where account data lives. JSON files on this Mac by default; Neon Postgres
// when DATABASE_URL (or POSTGRES_URL, as Vercel's Neon integration names it)
// is set — required on Vercel, optional locally.
//
// Contract (all async):
//   read(id)                       → the account's document (with rev)
//   write(id, next, expectedRev)   → { ok: true, rev } | { ok: false, current }
//                                    (saves only if nobody saved since expectedRev)
//   claimLegacy(id)                → moves pre-sign-in data to id (files only)
//   listUserIds()                  → every account with data (for reminders)
import { legacyStore, userStore, listUserIds, claimLegacy } from './store.js';

const emptyDoc = () => ({ rev: 0, accounts: [], snapshots: [], income: [], settings: {}, meta: {} });

export const databaseUrl = (env = process.env) => String(env.DATABASE_URL || env.POSTGRES_URL || '').trim();

export function fileStorage(dataDir) {
  const storeFor = (id) => (id === 'local' ? legacyStore(dataDir) : userStore(dataDir, id));
  return {
    kind: 'file',
    async read(id) {
      return storeFor(id).read();
    },
    async write(id, next, expectedRev) {
      const store = storeFor(id);
      const current = store.read();
      if ((current.rev ?? 0) !== expectedRev) return { ok: false, current };
      store.write(next);
      return { ok: true, rev: next.rev };
    },
    async claimLegacy(id) {
      return claimLegacy(dataDir, id);
    },
    async listUserIds() {
      return listUserIds(dataDir);
    },
  };
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS givemebucks_user_data (
  user_id    text PRIMARY KEY,
  data       jsonb NOT NULL,
  rev        integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

/** connect(url) → { query(text, params) → rows } — injectable for tests. */
export function neonStorage(url, { connect } = {}) {
  let ready = null;
  const db = () => (ready ||= (async () => {
    const sql = connect ? connect(url) : (await import('@neondatabase/serverless')).neon(url);
    await sql.query(SCHEMA); // creates the table on first use
    return sql;
  })().catch((err) => { ready = null; throw err; }));

  const parse = (data) => (typeof data === 'string' ? JSON.parse(data) : data);

  async function read(id) {
    const rows = await (await db()).query('SELECT data, rev FROM givemebucks_user_data WHERE user_id = $1', [id]);
    return rows.length ? { ...parse(rows[0].data), rev: rows[0].rev } : emptyDoc();
  }

  return {
    kind: 'database',
    read,
    async write(id, next, expectedRev) {
      const sql = await db();
      const { rev, ...data } = next;
      // Compare-and-set in one statement: the save lands only if the stored rev
      // is still the one the browser loaded (or, for a first save, no row yet).
      const rows = expectedRev === 0
        ? await sql.query('INSERT INTO givemebucks_user_data (user_id, data, rev) VALUES ($1, $2::jsonb, $3) ON CONFLICT (user_id) DO NOTHING RETURNING rev', [id, JSON.stringify(data), rev])
        : await sql.query('UPDATE givemebucks_user_data SET data = $2::jsonb, rev = $3, updated_at = now() WHERE user_id = $1 AND rev = $4 RETURNING rev', [id, JSON.stringify(data), rev, expectedRev]);
      if (rows.length) return { ok: true, rev: rows[0].rev };
      return { ok: false, current: await read(id) };
    },
    async claimLegacy() {
      return false; // nothing on disk in the cloud; import a backup from Settings instead
    },
    async listUserIds() {
      return (await (await db()).query('SELECT user_id FROM givemebucks_user_data ORDER BY user_id', [])).map((r) => r.user_id);
    },
  };
}

export function createStorage({ env = process.env, dataDir }) {
  const url = databaseUrl(env);
  return url ? neonStorage(url) : fileStorage(dataDir);
}
