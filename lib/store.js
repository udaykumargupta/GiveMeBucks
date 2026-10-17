// JSON-file persistence: atomic writes plus one rolling backup per day.
// Without sign-in there is one file (data/db.json). With Google sign-in each
// account gets its own file (data/users/<google-id>.json).
import fs from 'node:fs';
import path from 'node:path';

const KEEP_BACKUPS = 30;
const EMPTY = () => ({ rev: 0, accounts: [], snapshots: [], income: [], settings: {}, meta: {} });

export class Store {
  constructor(dir, name = 'db') {
    this.dir = dir;
    this.name = name;
    this.file = path.join(dir, `${name}.json`);
    this.backupDir = path.join(dir, 'backups');
    fs.mkdirSync(this.backupDir, { recursive: true });
  }

  exists() {
    return fs.existsSync(this.file);
  }

  read() {
    if (!this.exists()) return EMPTY();
    return JSON.parse(fs.readFileSync(this.file, 'utf8'));
  }

  write(db) {
    this.backup();
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, this.file);
  }

  backup() {
    if (!this.exists()) return;
    const prefix = `${this.name}-`;
    const stamp = new Date().toISOString().slice(0, 10);
    const target = path.join(this.backupDir, `${prefix}${stamp}.json`);
    if (!fs.existsSync(target)) fs.copyFileSync(this.file, target);
    const mine = fs.readdirSync(this.backupDir).filter((f) => f.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}\.json$/.test(f.slice(prefix.length))).sort();
    for (const f of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(this.backupDir, f));
  }
}

export const legacyStore = (dataDir) => new Store(dataDir, 'db');
export const userStore = (dataDir, userId) => new Store(path.join(dataDir, 'users'), userId);

/** Ids of every signed-in user that has data (for the reminder scheduler). */
export function listUserIds(dataDir) {
  const dir = path.join(dataDir, 'users');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
}

/**
 * One-time move of the pre-sign-in data (data/db.json) into a user's own file.
 * The original is renamed, not deleted, so it can never be claimed twice.
 */
export function claimLegacy(dataDir, userId) {
  const legacy = legacyStore(dataDir);
  const mine = userStore(dataDir, userId);
  if (!legacy.exists() || mine.exists()) return false;
  mine.write(legacy.read());
  fs.renameSync(legacy.file, path.join(dataDir, `db.claimed-by-${userId}.json`));
  return true;
}
