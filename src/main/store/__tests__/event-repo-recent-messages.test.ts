/**
 * event-repo `listRecentMessages` + `maxEventId` 单测
 * （plan resume-inject-raw-messages-20260601 §D5 测试矩阵 — message-only 查询部分）。
 *
 * 覆盖维度：
 * - listRecentMessages 只取 kind='message' + role∈{user,assistant} + error 非真（过滤 tool-use /
 *   file-changed / waiting / system / error message）
 * - 「最近 200 全 tool-use、更早有 message」场景：直接 SQL WHERE 拿到更早的 message（不受 raw
 *   events 密度影响 — 这是不用 listForSession+JS 过滤的根因，§D5 R1 MED）
 * - beforeIdInclusive 边界：`AND id <= ?` off-by-one（保留 emit 前最后一条 + 排除 emit 的当前消息）
 * - ORDER BY ts DESC, id DESC LIMIT N（同毫秒 id tie-breaker）
 * - maxEventId：返当前最大 id / 无 row 返 null
 *
 * 走 vi.mock('@main/store/db') 注入 in-memory testDb + 动态 import 生产 repo（照搬
 * repo-tiebreaker.test.ts harness 模式）。binding 不可用时整组 skip（CLAUDE.md SQLite binding 红线）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import v001 from '../migrations/v001_init.sql?raw';
import v002 from '../migrations/v002_sessions_source.sql?raw';
import v003 from '../migrations/v003_split_archive_from_lifecycle.sql?raw';
import v004 from '../migrations/v004_sessions_permission_mode.sql?raw';
import v005 from '../migrations/v005_fts.sql?raw';
import v006 from '../migrations/v006_sessions_team_name.sql?raw';
import v007 from '../migrations/v007_tasks.sql?raw';
import v008 from '../migrations/v008_sessions_codex_sandbox.sql?raw';
import v009 from '../migrations/v009_mcp_spawn_chain.sql?raw';
import v010 from '../migrations/v010_agent_deck_teams.sql?raw';
import v011 from '../migrations/v011_tasks_team_id.sql?raw';
import v012 from '../migrations/v012_sessions_generic_pty_config.sql?raw';
import v013 from '../migrations/v013_sessions_claude_code_sandbox.sql?raw';
import v014 from '../migrations/v014_drop_sessions_team_name.sql?raw';
import v015 from '../migrations/v015_agent_deck_messages_reply_to.sql?raw';
import v016 from '../migrations/v016_agent_deck_teams_archive_reason.sql?raw';
import v017 from '../migrations/v017_agent_deck_team_members_cascade.sql?raw';
import v018 from '../migrations/v018_sessions_model.sql?raw';
import v019 from '../migrations/v019_sessions_extra_allow_write.sql?raw';
import v020 from '../migrations/v020_sessions_cwd_release_marker.sql?raw';
import v021 from '../migrations/v021_sessions_cli_session_id.sql?raw';
import v022 from '../migrations/v022_events_tool_use_dedup.sql?raw';
import v023 from '../migrations/v023_tasks_owner_session_id_rewrite.sql?raw';
import v024 from '../migrations/v024_tasks_add_team_id.sql?raw';
import v025 from '../migrations/v025_events_tool_use_end_dedup.sql?raw';
import v026 from '../migrations/v026_issues.sql?raw';

const ALL_MIGRATIONS = [
  v001, v002, v003, v004, v005, v006, v007, v008, v009, v010, v011, v012,
  v013, v014, v015, v016, v017, v018, v019, v020, v021, v022, v023, v024,
  v025, v026,
];

const dbHolder: { current: Database.Database | null } = { current: null };
vi.mock('@main/store/db', () => ({
  getDb: () => {
    if (!dbHolder.current) {
      throw new Error('[event-repo-recent-messages.test] dbHolder.current 未注入');
    }
    return dbHolder.current;
  },
}));

import { bindingAvailable } from './_binding-probe';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const sql of ALL_MIGRATIONS) db.exec(sql);
  return db;
}

function insertSession(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO sessions
     (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES (?, 'claude-code', '/tmp', ?, 'sdk', 'active', 'idle', 1000, 1000)`,
  ).run(id, `title-${id}`);
}

/** 插一条 message-kind event（role + text [+ error]），返回自增 id。 */
function insertMessage(
  db: Database.Database,
  sessionId: string,
  role: 'user' | 'assistant',
  text: string,
  ts: number,
  error?: boolean,
): number {
  const payload: Record<string, unknown> = { role, text };
  if (error !== undefined) payload.error = error;
  const info = db
    .prepare(`INSERT INTO events (session_id, kind, payload_json, ts) VALUES (?, 'message', ?, ?)`)
    .run(sessionId, JSON.stringify(payload), ts);
  return Number(info.lastInsertRowid);
}

/** 插一条非 message-kind event（tool-use-start / file-changed 等），返回自增 id。 */
function insertNonMessage(
  db: Database.Database,
  sessionId: string,
  kind: string,
  ts: number,
): number {
  const info = db
    .prepare(`INSERT INTO events (session_id, kind, payload_json, ts) VALUES (?, ?, ?, ?)`)
    .run(sessionId, kind, JSON.stringify({ tag: kind }), ts);
  return Number(info.lastInsertRowid);
}

describe.skipIf(!bindingAvailable)('event-repo listRecentMessages / maxEventId (plan resume-inject §D5)', () => {
  let testDb: Database.Database;
  let mod: typeof import('../event-repo');

  beforeEach(async () => {
    testDb = makeDb();
    dbHolder.current = testDb;
    mod = await import('../event-repo');
    insertSession(testDb, 'sess-A');
  });
  afterEach(() => {
    dbHolder.current = null;
    testDb.close();
  });

  it('只取 message kind + role∈{user,assistant}，过滤 tool-use / file-changed', () => {
    insertMessage(testDb, 'sess-A', 'user', '用户问题', 1000);
    insertNonMessage(testDb, 'sess-A', 'tool-use-start', 1001);
    insertMessage(testDb, 'sess-A', 'assistant', '助手回答', 1002);
    insertNonMessage(testDb, 'sess-A', 'file-changed', 1003);
    insertNonMessage(testDb, 'sess-A', 'waiting-for-user', 1004);

    const rows = mod.eventRepo.listRecentMessages('sess-A', 30);
    expect(rows).toHaveLength(2);
    const texts = rows.map((r) => (r.payload as { text: string }).text).sort();
    expect(texts).toEqual(['助手回答', '用户问题']);
  });

  it('过滤 error=true 的 message（如 ⚠ 警告），保留 error 非真', () => {
    insertMessage(testDb, 'sess-A', 'assistant', '正常回答', 1000);
    insertMessage(testDb, 'sess-A', 'assistant', '⚠ 错误消息', 1001, true);
    insertMessage(testDb, 'sess-A', 'user', '无 error 字段', 1002); // error undefined

    const rows = mod.eventRepo.listRecentMessages('sess-A', 30);
    const texts = rows.map((r) => (r.payload as { text: string }).text).sort();
    expect(texts).toEqual(['无 error 字段', '正常回答']);
  });

  it('过滤非 user/assistant role（如 system / 无 role）', () => {
    insertMessage(testDb, 'sess-A', 'user', '用户消息', 1000);
    // 无 role 的 message（如 fallback info / placeholder ⚠ 消息）
    testDb
      .prepare(`INSERT INTO events (session_id, kind, payload_json, ts) VALUES ('sess-A', 'message', ?, 1001)`)
      .run(JSON.stringify({ text: '⚠ SDK 通道已断开' })); // 无 role
    const rows = mod.eventRepo.listRecentMessages('sess-A', 30);
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as { text: string }).text).toBe('用户消息');
  });

  it('「最近 200 全 tool-use、更早有 message」→ SQL 直接拿到更早 message（不受 raw 密度影响）', () => {
    // 先插 2 条早期对话
    insertMessage(testDb, 'sess-A', 'user', '早期问题', 1000);
    insertMessage(testDb, 'sess-A', 'assistant', '早期回答', 1001);
    // 再插 250 条 tool-use（淹没 listForSession 默认 limit=200 窗口）
    for (let i = 0; i < 250; i++) {
      insertNonMessage(testDb, 'sess-A', 'tool-use-start', 2000 + i);
    }
    // listRecentMessages 仍直接拿到 2 条对话（WHERE kind='message' 不受 tool-use 密度影响）
    const rows = mod.eventRepo.listRecentMessages('sess-A', 30);
    expect(rows).toHaveLength(2);
    const texts = rows.map((r) => (r.payload as { text: string }).text).sort();
    expect(texts).toEqual(['早期回答', '早期问题']);
  });

  it('LIMIT N：超过 N 条只取最近 N（ORDER BY ts DESC）', () => {
    for (let i = 0; i < 10; i++) {
      insertMessage(testDb, 'sess-A', 'user', `消息${i}`, 1000 + i);
    }
    const rows = mod.eventRepo.listRecentMessages('sess-A', 3);
    expect(rows).toHaveLength(3);
    // ORDER BY ts DESC → 取最近 3 条（消息9/8/7）
    const texts = rows.map((r) => (r.payload as { text: string }).text);
    expect(texts).toEqual(['消息9', '消息8', '消息7']);
  });

  it('同毫秒 ts → id DESC tie-breaker（取最晚插入）', () => {
    const idOld = insertMessage(testDb, 'sess-A', 'user', '同毫秒旧', 5000);
    const idNew = insertMessage(testDb, 'sess-A', 'user', '同毫秒新', 5000); // 同 ts，id 更大
    const rows = mod.eventRepo.listRecentMessages('sess-A', 30);
    // DESC：id 大（新）在前
    expect(rows[0].id).toBe(idNew);
    expect(rows[1].id).toBe(idOld);
    void idOld;
  });

  it('beforeIdInclusive：AND id <= ? 保留 emit 前最后一条 + 排除之后的当前消息（off-by-one）', () => {
    const id1 = insertMessage(testDb, 'sess-A', 'user', '历史问 A', 1000);
    const id2 = insertMessage(testDb, 'sess-A', 'assistant', '历史答 B', 1001);
    // 模拟 entry emit 的「当前消息」（id 更大）
    const idCurrent = insertMessage(testDb, 'sess-A', 'user', '当前消息（应被排除）', 1002);

    // maxEventIdBefore = emit 前的 max id = id2（历史答 B）
    const rows = mod.eventRepo.listRecentMessages('sess-A', 30, id2);
    const texts = rows.map((r) => (r.payload as { text: string }).text);
    // id <= id2 → 保留 id1 + id2，排除 idCurrent（id > id2）
    expect(texts).toContain('历史问 A');
    expect(texts).toContain('历史答 B');
    expect(texts).not.toContain('当前消息（应被排除）');
    expect(rows).toHaveLength(2);
    void id1;
    void idCurrent;
  });

  it('beforeIdInclusive=id1 → 只保留 id1（`<=` 含界，验非 `<`）', () => {
    const id1 = insertMessage(testDb, 'sess-A', 'user', '第一条', 1000);
    insertMessage(testDb, 'sess-A', 'user', '第二条', 1001);
    const rows = mod.eventRepo.listRecentMessages('sess-A', 30, id1);
    // <= id1 → 只有第一条（若误用 < id1 则 0 条，验 off-by-one）
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as { text: string }).text).toBe('第一条');
  });

  it('maxEventId：返当前最大 id', () => {
    insertMessage(testDb, 'sess-A', 'user', 'm1', 1000);
    const id2 = insertNonMessage(testDb, 'sess-A', 'tool-use-start', 1001); // maxEventId 不限 kind
    expect(mod.eventRepo.maxEventId('sess-A')).toBe(id2);
  });

  it('maxEventId：无 row 返 null', () => {
    expect(mod.eventRepo.maxEventId('sess-A')).toBeNull();
    expect(mod.eventRepo.maxEventId('不存在的-session')).toBeNull();
  });

  it('listRecentMessages：跨 session 隔离（只取本 session）', () => {
    insertSession(testDb, 'sess-B');
    insertMessage(testDb, 'sess-A', 'user', 'A 的消息', 1000);
    insertMessage(testDb, 'sess-B', 'user', 'B 的消息', 1001);
    const rowsA = mod.eventRepo.listRecentMessages('sess-A', 30);
    expect(rowsA).toHaveLength(1);
    expect((rowsA[0].payload as { text: string }).text).toBe('A 的消息');
  });
});
