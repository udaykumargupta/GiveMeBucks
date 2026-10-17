// JSON-file persistence: atomic writes plus one rolling backup per day.
import fs from 'node:fs';
import path from 'node:path';

const KEEP_BACKUPS = 30;

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.backupDir = path.join(dir, 'backups');
    fs.mkdirSync(this.backupDir, { recursive: true });
  }

  read() {
    if (!fs.existsSync(this.file)) return { rev: 0, accounts: [], snapshots: [], income: [], settings: {}, meta: {} };
    return JSON.parse(fs.readFileSync(this.file, 'utf8'));
  }

  write(db) {
    this.backup();
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, this.file);
  }

  backup() {
    if (!fs.existsSync(this.file)) return;
    const stamp = new Date().toISOString().slice(0, 10);
    const target = path.join(this.backupDir, `db-${stamp}.json`);
    if (!fs.existsSync(target)) fs.copyFileSync(this.file, target);
    const all = fs.readdirSync(this.backupDir).filter((f) => f.startsWith('db-')).sort();
    for (const f of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(this.backupDir, f));
  }
}
