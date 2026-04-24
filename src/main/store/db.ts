import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { MIGRATIONS } from './migrations';

let dbInstance: Database.Database | null = null;

export function initDb(): Database.Database {
  if (dbInstance) return dbInstance;

  const userDataDir = app.getPath('userData');
  mkdirSync(userDataDir, { recursive: true });
  const dbPath = join(userDataDir, 'agent-deck.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // V5 FTS5 触发器从 trigger 写虚表（INSERT INTO events_fts(events_fts, ...)）。
  // SQLite 在 trusted_schema=OFF 时拒之报 "unsafe use of virtual table"。
  // better-sqlite3 11.x 编译时默认 trusted_schema=ON，但显式置一遍防御未来 binding 默认变化
  // （review N5 #10）。
  db.pragma('trusted_schema = ON');

  const userVersion = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  // sort by version 防御：如果 migrations/index.ts 数组顺序被改乱（cherry-pick 历史
  // hotfix 插错位置），DDL 顺序错就会乱套。零成本兜底（review N5 #11）。
  const pending = MIGRATIONS
    .filter((m) => m.version > userVersion)
    .sort((a, b) => a.version - b.version);

  if (pending.length > 0) {
    const tx = db.transaction(() => {
      for (const m of pending) {
        db.exec(m.sql);
        db.pragma(`user_version = ${m.version}`);
        console.log(`[db] migrated to v${m.version} (${m.name})`);
      }
    });
    tx();
  }

  dbInstance = db;
  return db;
}

export function getDb(): Database.Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
