import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { MIGRATIONS } from './migrations';
import log from '@main/utils/logger';

const logger = log.scope('store-db');

let dbInstance: Database.Database | null = null;

/**
 * 「已显式关闭」标记 —— 仅 closeDb() 置 true,initDb() 复位 false。
 *
 * shutdown race guard（issue shutdown-race-ingest-db-guard）:before-quit finally 跑 closeDb() 后
 * (REVIEW_104 MED-B 为 WAL checkpoint 不变量提前到 finally),adapter in-flight 尾包(shutdownAll
 * drain 完成前已 emit 的事件 / 迟到 SDK 流尾包)仍会飞到 emit sink → sessionManager.ingest →
 * findByCliSessionId → getDb()。此时 dbInstance 已 null → db.ts throw → 在 adapter async 流上
 * 变 unhandledRejection 落盘噪音(logger.ts unhandledRejection 仅落盘不强退,非 crash)。caller 先查
 * isDbClosed()===true 时直接 drop 退出期事件(本就无需持久化)。
 *
 * **区分 init-never vs closed(关键不变量,防掩盖启动期真 bug)**:本 flag 仅 closeDb() 置 true。
 * 启动期 initDb 之前 dbInstance=null 但 dbClosed=false → isDbClosed() 返 false → caller 不 drop →
 * getDb() 照常 loud throw "Database not initialized",不掩盖真正的「启动顺序漏 initDb」bug。
 * 只有「正常跑过 → 显式 closeDb」这一条退出路径才让 caller 静默 drop。
 */
let dbClosed = false;

export function initDb(): Database.Database {
  if (dbInstance) return dbInstance;
  // initDb 成功路径会落到末尾置 dbInstance；这里先复位 closed 标记,让「关闭后理论上重开」
  // (当前生命周期无此路径,纯防御)也能恢复 isDbClosed()===false 语义。
  dbClosed = false;

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
        logger.info(`[db] migrated to v${m.version} (${m.name})`);
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

/**
 * 是否已显式关闭(closeDb 跑过且未再 initDb)。
 *
 * 退出期热路径 caller（sessionManager.ingest 入口 / bootstrap-infra emit sink）先查此 flag,
 * true 时直接 drop 事件,避免 getDb() 在 dbInstance=null 上 throw → adapter async 流 unhandledRejection
 * 落盘噪音（详 dbClosed flag jsdoc）。**不要**用 `dbInstance === null` 替代:那会把启动期 init-never
 * 也算进来,掩盖「漏 initDb」真 bug。
 */
export function isDbClosed(): boolean {
  return dbClosed;
}

export function closeDb(): void {
  // dbClosed 先于 dbInstance.close() 置位:close() 是同步操作,但置位顺序无害且语义上「一旦决定关闭
  // 就拒绝后续写」。即便 close() 抛错(WAL checkpoint 失败等),flag 已 true,退出期尾包仍被 drop。
  dbClosed = true;
  // dbInstance=null 放 finally:close() 抛错(WAL checkpoint 失败)时也必须清空,否则留下
  // 「dbClosed=true + dbInstance≠null」中间态 — 当前 shutdown 用途无害(热路径 caller 都 gate
  // 在 isDbClosed 上不读 dbInstance),但若未来接「关闭后重开」(initDb:if(dbInstance)return 在
  // dbClosed=false reset 之前)会返回 broken instance 且永卡 isDbClosed()=true。finally 清空让
  // 防御性 reopen 真正 robust(REVIEW shutdown-guard LOW-1)。
  if (dbInstance) {
    try {
      dbInstance.close();
    } finally {
      dbInstance = null;
    }
  }
}
