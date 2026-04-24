/**
 * Migration 注册表（CHANGELOG_22 / Phase 4 N4 单轨化）
 *
 * 历史：之前 db.ts 内联 V1-V4 SQL 字符串 + migrations/v001_init.sql 同时存在但只有
 * v001 被同步、v002-v004 完全没有文件，外人维护极易写错（以为改 sql 文件生效）。
 * 现在唯一来源是 migrations/v00x_*.sql，db.ts 通过本文件 import。
 *
 * 用 Vite 的 `?raw` import：build 时把 sql 文件作为字符串内联到 main bundle，运行时
 * 不需要 fs.readFileSync，避免 dev/asar 路径分歧（CHANGELOG_15 ENOTDIR 教训）。
 *
 * 加新 migration（V5+）：写 v00X_xxx.sql + 在数组里加一行 import + push 进 MIGRATIONS。
 * version 字段必须严格递增、连续；name 用于日志与排错。
 */
import v001 from './v001_init.sql?raw';
import v002 from './v002_sessions_source.sql?raw';
import v003 from './v003_split_archive_from_lifecycle.sql?raw';
import v004 from './v004_sessions_permission_mode.sql?raw';
import v005 from './v005_fts.sql?raw';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'init', sql: v001 },
  { version: 2, name: 'sessions_source', sql: v002 },
  { version: 3, name: 'split_archive_from_lifecycle', sql: v003 },
  { version: 4, name: 'sessions_permission_mode', sql: v004 },
  { version: 5, name: 'fts5', sql: v005 },
];
