// JSON-file persistence: atomic writes plus one rolling backup per day.
// Without sign-in there is one document (data/db.v2.json); with Google sign-in
// each account gets its own (data/users/<google-id>.v2.json). The v1 files
// (data/db.json, data/users/<id>.json) are only ever read, never written.
import fs from 'node:fs';
import path from 'node:path';

const KEEP_BACKUPS = 30;

export class Store {
  constructor(dir, name = 'db') {
    this.dir = dir;
    this.name = name;
    this.file = path.join(dir, `${name}.json`);
    this.backupDir = path.join(dir, 'backups');
  }

  exists() {
    return fs.existsSync(this.file);
  }

  /** The stored document, or null when there is none. */
  read() {
    if (!this.exists()) return null;
    return JSON.parse(fs.readFileSync(this.file, 'utf8'));
  }

  write(db) {
    fs.mkdirSync(this.dir, { recursive: true });
    this.backup();
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, this.file);
  }

  backup() {
    if (!this.exists()) return;
    fs.mkdirSync(this.backupDir, { recursive: true });
    const prefix = `${this.name}-`;
    const stamp = new Date().toISOString().slice(0, 10);
    const target = path.join(this.backupDir, `${prefix}${stamp}.json`);
    if (!fs.existsSync(target)) fs.copyFileSync(this.file, target);
    const mine = fs.readdirSync(this.backupDir).filter((f) => f.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}\.json$/.test(f.slice(prefix.length))).sort();
    for (const f of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(this.backupDir, f));
  }
}

// v1 (read-only) and v2 documents. 'local' is the single pre-sign-in user.
// User ids never contain a dot (safeUserId), so "<id>.v2" cannot clash with a v1 name.
export const legacyStore = (dataDir) => new Store(dataDir, 'db');
export const userStore = (dataDir, userId) => new Store(path.join(dataDir, 'users'), userId);
export const legacyStoreV2 = (dataDir) => new Store(dataDir, 'db.v2');
export const userStoreV2 = (dataDir, userId) => new Store(path.join(dataDir, 'users'), `${userId}.v2`);

/**
 * One-time move of the pre-sign-in data (data/db.json and data/db.v2.json) into
 * a user's own files. Each file moves only if the user has no such file yet; the
 * original is copied byte for byte and then renamed, not deleted, so it can never
 * be claimed twice. → true when anything moved.
 * A user who already has their own v1 file keeps it as the source of their v2 data:
 * the local db.v2.json is then left alone, or it would hide that v1 data for good.
 */
export function claimLegacy(dataDir, userId) {
  let moved = false;
  const ownV1 = userStore(dataDir, userId).exists();
  for (const [from, to] of [
    [legacyStore(dataDir), userStore(dataDir, userId)],
    [legacyStoreV2(dataDir), userStoreV2(dataDir, userId)],
  ]) {
    if (!from.exists() || to.exists()) continue;
    if (ownV1 && from.name === 'db.v2') continue;
    fs.mkdirSync(to.dir, { recursive: true });
    fs.copyFileSync(from.file, to.file, fs.constants.COPYFILE_EXCL);
    fs.renameSync(from.file, path.join(dataDir, `${from.name}.claimed-by-${userId}.json`));
    moved = true;
  }
  return moved;
}
