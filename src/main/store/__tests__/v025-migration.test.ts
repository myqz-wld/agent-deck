/**
 * v025 migration 单测（REVIEW_54）— v022 对称迁移。
 *
 * 验 v025 行为:
 *
 * **sub-case A**: 新建 db post-v025 → 验:
 *   - events_tool_use_end_dedup partial UNIQUE INDEX 就位
 *   - INDEX WHERE 子句 = `kind = 'tool-use-end' AND tool_use_id IS NOT NULL`
 *   - v022 创建的 events_tool_use_start_dedup 仍存在（不被推翻）
 *   - 同 (session_id, kind='tool-use-end', tool_use_id) 第二次 INSERT 触发 UNIQUE 冲突
 *
 * **sub-case B**: v022→v025 跨版本升级 path,模拟真用户升级:
 *   - applyMigrations(['001'...'v024']) 落老 schema（仅 start dedup index 就位）
 *   - seed fixture: 3 行同 (session, toolUseId) 的 tool-use-end + 2 行 tool-use-start 控制组
 *   - applyMigrations(['v025']) 升级
 *   - 验: 冗余 tool-use-end 仅保 ts DESC, id DESC 首行 + start 控制组零受影响
 *   - 验: 升级后再 INSERT 同 toolUseId tool-use-end 走 UPSERT（不报 UNIQUE 错）
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

// Fix 4 (REVIEW_54 双对抗 codex LOW-2 修法):
// 让 sub-case C 能直接 import eventRepo.insert 跑真生产分支（抓 ternary kindLiteral
// 选择 / extractToolUseId 守门 / safeStringifyPayload 漂移）。vi.mock 闭包 dbHolder
// 让每个 it 注入自己的 testDb；sub-case A / B 不 import eventRepo 不受影响。
const dbHolder: { current: Database.Database | null } = { current: null };
vi.mock('@main/store/db', () => ({
  getDb: () => {
    if (!dbHolder.current) {
      throw new Error('[v025-migration.test] dbHolder.current 未注入 — 仅 sub-case C 应触发本路径');
    }
    return dbHolder.current;
  },
}));

const PRE_V025 = [
  v001, v002, v003, v004, v005, v006, v007, v008, v009, v010, v011, v012,
  v013, v014, v015, v016, v017, v018, v019, v020, v021, v022, v023, v024,
];

function probeBetterSqliteBinding(): boolean {
  try {
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch (e) {
    console.warn(
      `[v025-migration.test] better-sqlite3 binding 不可用，跳过本文件全部用例。原因：${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}
const bindingAvailable = probeBetterSqliteBinding();

function makeDbAt(version: 'pre-v025' | 'post-v025'): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const sql of PRE_V025) db.exec(sql);
  if (version === 'post-v025') db.exec(v025);
  return db;
}

function insertSession(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO sessions
     (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES (?, 'codex-cli', '/tmp', ?, 'sdk', 'active', 'idle', ?, ?)`,
  ).run(id, `title-${id}`, 1000, 1000);
}

function insertEvent(
  db: Database.Database,
  sessionId: string,
  kind: 'tool-use-start' | 'tool-use-end',
  toolUseId: string | null,
  ts: number,
  extraPayload: Record<string, unknown> = {},
): number {
  const payload = JSON.stringify({ ...extraPayload, ...(toolUseId ? { toolUseId } : {}) });
  const info = db
    .prepare(
      `INSERT INTO events (session_id, kind, payload_json, ts, tool_use_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(sessionId, kind, payload, ts, toolUseId);
  return Number(info.lastInsertRowid);
}

describe.skipIf(!bindingAvailable)('v025 migration / sub-case A: partial UNIQUE INDEX', () => {
  it('post-v025: events_tool_use_end_dedup partial UNIQUE INDEX 就位（WHERE 子句对齐）', () => {
    const db = makeDbAt('post-v025');
    try {
      const idx = db
        .prepare(
          `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' AND name = 'events_tool_use_end_dedup'`,
        )
        .get() as { name: string; sql: string } | undefined;
      expect(idx).toBeDefined();
      expect(idx?.sql).toContain('WHERE');
      expect(idx?.sql).toContain("kind = 'tool-use-end'");
      expect(idx?.sql).toContain('tool_use_id IS NOT NULL');
    } finally {
      db.close();
    }
  });

  it('post-v025: v022 创建的 events_tool_use_start_dedup 仍存在（不被推翻）', () => {
    const db = makeDbAt('post-v025');
    try {
      const idx = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' AND name = 'events_tool_use_start_dedup'`,
        )
        .get() as { name: string } | undefined;
      expect(idx).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('post-v025: 同 (session, kind=tool-use-end, toolUseId) 第二次 INSERT 触发 UNIQUE 冲突', () => {
    const db = makeDbAt('post-v025');
    try {
      insertSession(db, 'sess-A');
      insertEvent(db, 'sess-A', 'tool-use-end', 'item_1', 1000);
      expect(() =>
        insertEvent(db, 'sess-A', 'tool-use-end', 'item_1', 2000),
      ).toThrow(/UNIQUE constraint failed/i);
    } finally {
      db.close();
    }
  });

  it('post-v025: tool-use-start 与 tool-use-end 同 toolUseId 各自独立（两 partial index 互斥）', () => {
    const db = makeDbAt('post-v025');
    try {
      insertSession(db, 'sess-A');
      // start + end 同 toolUseId 是合法配对（不同 partial index）
      insertEvent(db, 'sess-A', 'tool-use-start', 'item_1', 1000);
      insertEvent(db, 'sess-A', 'tool-use-end', 'item_1', 2000);
      const count = (db.prepare(`SELECT COUNT(*) AS c FROM events`).get() as { c: number }).c;
      expect(count).toBe(2);
    } finally {
      db.close();
    }
  });

  it('post-v025: tool_use_id IS NULL 的 tool-use-end 不受 partial index 约束（任意多行）', () => {
    const db = makeDbAt('post-v025');
    try {
      insertSession(db, 'sess-A');
      // 3 行 tool-use-end 都 toolUseId=null（partial WHERE 不命中）→ 全部允许
      insertEvent(db, 'sess-A', 'tool-use-end', null, 1000);
      insertEvent(db, 'sess-A', 'tool-use-end', null, 2000);
      insertEvent(db, 'sess-A', 'tool-use-end', null, 3000);
      const count = (
        db
          .prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'tool-use-end'`)
          .get() as { c: number }
      ).c;
      expect(count).toBe(3);
    } finally {
      db.close();
    }
  });
});

describe.skipIf(!bindingAvailable)('v025 migration / sub-case B: v024 → v025 跨版本升级 path', () => {
  it('seed 3 行同 toolUseId tool-use-end → 升级后保 ts DESC, id DESC 首行（与 listForSession 排序对齐）', () => {
    const db = makeDbAt('pre-v025');
    try {
      insertSession(db, 'sess-A');

      // seed 3 行同 (sess-A, tool-use-end, item_1):
      //   id=1 ts=100  ← 最早
      //   id=2 ts=300  ← ts DESC 首行（保这条）
      //   id=3 ts=200
      // 验 cleanup 选 id=2 不是 id=3 (MAX(id))
      const id1 = insertEvent(db, 'sess-A', 'tool-use-end', 'item_1', 100, { v: 'old' });
      const id2 = insertEvent(db, 'sess-A', 'tool-use-end', 'item_1', 300, { v: 'newest' });
      const id3 = insertEvent(db, 'sess-A', 'tool-use-end', 'item_1', 200, { v: 'mid' });

      // start 控制组（不参与 v025 cleanup）
      const startId = insertEvent(db, 'sess-A', 'tool-use-start', 'item_1', 100);

      // 第二组 toolUseId 单独占一行（升级后 noop）
      const otherId = insertEvent(db, 'sess-A', 'tool-use-end', 'item_2', 100);

      // 升级到 v025
      db.exec(v025);

      // 验 cleanup 结果：item_1 仅剩 id=2（ts=300 newest），id=1/id=3 被删
      const remainingItem1 = db
        .prepare(
          `SELECT id, payload_json FROM events WHERE session_id = ? AND kind = 'tool-use-end' AND tool_use_id = ? ORDER BY id`,
        )
        .all('sess-A', 'item_1') as Array<{ id: number; payload_json: string }>;
      expect(remainingItem1).toHaveLength(1);
      expect(remainingItem1[0].id).toBe(id2);
      expect(JSON.parse(remainingItem1[0].payload_json)).toMatchObject({ v: 'newest' });
      // 确认 id1/id3 真被删
      const id1Row = db.prepare(`SELECT id FROM events WHERE id = ?`).get(id1);
      const id3Row = db.prepare(`SELECT id FROM events WHERE id = ?`).get(id3);
      expect(id1Row).toBeUndefined();
      expect(id3Row).toBeUndefined();

      // start 控制组未受影响（v025 仅清 tool-use-end）
      const startRow = db.prepare(`SELECT id FROM events WHERE id = ?`).get(startId);
      expect(startRow).toEqual({ id: startId });

      // item_2 一行未受影响
      const otherRow = db.prepare(`SELECT id FROM events WHERE id = ?`).get(otherId);
      expect(otherRow).toEqual({ id: otherId });
    } finally {
      db.close();
    }
  });

  it('升级后再 INSERT 同 toolUseId tool-use-end 直接 INSERT 报 UNIQUE 错（应用层 UPSERT 由 event-repo 处理）', () => {
    const db = makeDbAt('pre-v025');
    try {
      insertSession(db, 'sess-A');
      insertEvent(db, 'sess-A', 'tool-use-end', 'item_1', 100);
      db.exec(v025);

      // 第二次裸 INSERT → partial UNIQUE INDEX 拦截
      expect(() =>
        insertEvent(db, 'sess-A', 'tool-use-end', 'item_1', 200),
      ).toThrow(/UNIQUE constraint failed/i);
    } finally {
      db.close();
    }
  });

  it('升级后用 event-repo 同款 UPSERT SQL 替 payload+ts（row id 不变）', () => {
    const db = makeDbAt('pre-v025');
    try {
      insertSession(db, 'sess-A');
      const originalId = insertEvent(db, 'sess-A', 'tool-use-end', 'item_1', 100, { v: 'first' });
      db.exec(v025);

      // 模拟 event-repo.insert tool-use-end 分支的 UPSERT
      const row = db
        .prepare(
          `INSERT INTO events (session_id, kind, payload_json, ts, tool_use_id)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id, kind, tool_use_id)
             WHERE kind = 'tool-use-end' AND tool_use_id IS NOT NULL
             DO UPDATE SET payload_json = excluded.payload_json, ts = excluded.ts
           RETURNING id`,
        )
        .get(
          'sess-A',
          'tool-use-end',
          JSON.stringify({ toolUseId: 'item_1', v: 'updated' }),
          500,
          'item_1',
        ) as { id: number };

      // UPSERT 命中 conflict → row id 不变
      expect(row.id).toBe(originalId);

      // payload + ts 已更新到最新
      const cur = db
        .prepare(`SELECT payload_json, ts FROM events WHERE id = ?`)
        .get(originalId) as { payload_json: string; ts: number };
      expect(JSON.parse(cur.payload_json)).toMatchObject({ v: 'updated' });
      expect(cur.ts).toBe(500);

      // 该 (session, kind, toolUseId) 仅 1 行
      const count = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM events WHERE session_id = ? AND kind = ? AND tool_use_id = ?`,
          )
          .get('sess-A', 'tool-use-end', 'item_1') as { c: number }
      ).c;
      expect(count).toBe(1);
    } finally {
      db.close();
    }
  });

  it('seed 含 toolUseId 为空串 / number / object / boolean / 缺失 的 tool-use-end → 升级仍合法（v022 LOW 守门 json_type=text 已分流，仅 string 行参与 cleanup）', () => {
    const db = makeDbAt('pre-v025');
    try {
      insertSession(db, 'sess-A');
      // 历史 row: tool_use_id 列已是 NULL（v022 回填时空串 / 非 string 被守门跳过）
      // 这些行的 payload_json 带各类非 string toolUseId 但 tool_use_id 列均 NULL。
      // codex LOW-1 finding（REVIEW_54 双对抗补强）: 修前仅 seed 空串 + null，未真覆盖
      // 「非 string」（number / object / boolean）；现补齐三类 + 缺失字段共 5 类。
      const emptyStrId = Number(
        db
          .prepare(
            `INSERT INTO events (session_id, kind, payload_json, ts, tool_use_id) VALUES (?, ?, ?, ?, ?)`,
          )
          .run('sess-A', 'tool-use-end', JSON.stringify({ toolUseId: '' }), 100, null).lastInsertRowid,
      );
      const numericId = Number(
        db
          .prepare(
            `INSERT INTO events (session_id, kind, payload_json, ts, tool_use_id) VALUES (?, ?, ?, ?, ?)`,
          )
          .run('sess-A', 'tool-use-end', JSON.stringify({ toolUseId: 123 }), 110, null).lastInsertRowid,
      );
      const objectId = Number(
        db
          .prepare(
            `INSERT INTO events (session_id, kind, payload_json, ts, tool_use_id) VALUES (?, ?, ?, ?, ?)`,
          )
          .run('sess-A', 'tool-use-end', JSON.stringify({ toolUseId: { nested: 'x' } }), 120, null)
          .lastInsertRowid,
      );
      const booleanId = Number(
        db
          .prepare(
            `INSERT INTO events (session_id, kind, payload_json, ts, tool_use_id) VALUES (?, ?, ?, ?, ?)`,
          )
          .run('sess-A', 'tool-use-end', JSON.stringify({ toolUseId: true }), 130, null).lastInsertRowid,
      );
      const missingFieldId = Number(
        db
          .prepare(
            `INSERT INTO events (session_id, kind, payload_json, ts, tool_use_id) VALUES (?, ?, ?, ?, ?)`,
          )
          .run('sess-A', 'tool-use-end', JSON.stringify({ otherField: 'x' }), 140, null).lastInsertRowid,
      );
      // 控制组：真 string + 非空 toolUseId（应走 dedup）
      const realStringId = insertEvent(db, 'sess-A', 'tool-use-end', 'item_real', 200);

      // 升级不报错（partial WHERE tool_use_id IS NOT NULL，5 类 NULL 行不命中）
      expect(() => db.exec(v025)).not.toThrow();

      // 全部 6 行保留（5 NULL 行不参与 dedup + 1 真 string 行单独占位）
      const rows = db
        .prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'tool-use-end'`)
        .get() as { c: number };
      expect(rows.c).toBe(6);

      // 5 个 NULL 行 id 全部还在
      for (const id of [emptyStrId, numericId, objectId, booleanId, missingFieldId, realStringId]) {
        const r = db.prepare(`SELECT id FROM events WHERE id = ?`).get(id);
        expect(r).toEqual({ id });
      }

      // 验 v025 step 1 UPDATE 回填守门：NULL 列保持 NULL（json_type 非 text 不回填）
      const nullCol = db
        .prepare(
          `SELECT COUNT(*) AS c FROM events WHERE kind = 'tool-use-end' AND tool_use_id IS NULL`,
        )
        .get() as { c: number };
      expect(nullCol.c).toBe(5);
    } finally {
      db.close();
    }
  });
});

// ---- sub-case C: event-repo integration ----
// Fix 4 (REVIEW_54 双对抗 codex LOW-2 修法): 现有 sub-case A/B 全跑裸 SQL，抓不到
// 生产 event-repo.insert 的 ternary kindLiteral 选择 / extractToolUseId 守门 /
// safeStringifyPayload 漂移。本组动态 import eventRepo，注入 testDb 跑真生产分支。
// 注：动态 import 因 vi.mock 已 hoist 必先于 import 生效（vi.hoisted 语义），eventRepo
// 模块加载时拿到的 getDb 已是 mock 闭包 dbHolder。
describe.skipIf(!bindingAvailable)('v025 migration / sub-case C: event-repo integration（生产 UPSERT 分支）', () => {
  let testDb: Database.Database;
  let eventRepoModule: typeof import('../event-repo');

  beforeEach(async () => {
    testDb = makeDbAt('post-v025');
    dbHolder.current = testDb;
    // 动态 import 确保 vi.mock 已生效（vitest hoist vi.mock 早于 ESM import）
    eventRepoModule = await import('../event-repo');
    insertSession(testDb, 'sess-A');
  });
  afterEach(() => {
    dbHolder.current = null;
    testDb.close();
  });

  it('eventRepo.insert tool-use-start：第二次同 toolUseId 走 UPSERT 命中 conflict，row id 不变 + payload 替最新', () => {
    const evStart1 = {
      sessionId: 'sess-A',
      agentId: 'codex-cli',
      kind: 'tool-use-start' as const,
      payload: { toolUseId: 'item_x', toolName: 'Bash', toolInput: { command: 'first' } },
      ts: 100,
    };
    const id1 = eventRepoModule.eventRepo.insert(evStart1);
    const evStart2 = { ...evStart1, payload: { ...evStart1.payload, toolInput: { command: 'second' } }, ts: 200 };
    const id2 = eventRepoModule.eventRepo.insert(evStart2);

    expect(id2).toBe(id1); // UPSERT 命中 conflict → row id 不变（ternary 选 'tool-use-start' 字面对齐 v022 partial index）
    const row = testDb.prepare(`SELECT payload_json, ts FROM events WHERE id = ?`).get(id1) as {
      payload_json: string;
      ts: number;
    };
    expect(JSON.parse(row.payload_json).toolInput.command).toBe('second');
    expect(row.ts).toBe(200);
    const count = (testDb.prepare(`SELECT COUNT(*) AS c FROM events`).get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('eventRepo.insert tool-use-end：第二次同 toolUseId 走 UPSERT 命中 conflict，row id 不变（v025 + ternary 选 tool-use-end 字面）', () => {
    const evEnd1 = {
      sessionId: 'sess-A',
      agentId: 'codex-cli',
      kind: 'tool-use-end' as const,
      payload: { toolUseId: 'item_y', toolName: 'Bash', toolResult: 'first-output', status: 'completed' },
      ts: 100,
    };
    const id1 = eventRepoModule.eventRepo.insert(evEnd1);
    const evEnd2 = { ...evEnd1, payload: { ...evEnd1.payload, toolResult: 'second-output' }, ts: 200 };
    const id2 = eventRepoModule.eventRepo.insert(evEnd2);

    expect(id2).toBe(id1);
    const row = testDb.prepare(`SELECT payload_json FROM events WHERE id = ?`).get(id1) as {
      payload_json: string;
    };
    expect(JSON.parse(row.payload_json).toolResult).toBe('second-output');
  });

  it('eventRepo.insert tool-use-start + tool-use-end 同 toolUseId 各占一行（两 partial UNIQUE INDEX 互斥，ternary 选对 WHERE 字面）', () => {
    const id1 = eventRepoModule.eventRepo.insert({
      sessionId: 'sess-A',
      agentId: 'codex-cli',
      kind: 'tool-use-start',
      payload: { toolUseId: 'item_z', toolName: 'Bash', toolInput: { command: 'x' } },
      ts: 100,
    });
    const id2 = eventRepoModule.eventRepo.insert({
      sessionId: 'sess-A',
      agentId: 'codex-cli',
      kind: 'tool-use-end',
      payload: { toolUseId: 'item_z', toolName: 'Bash', toolResult: 'ok', status: 'completed' },
      ts: 200,
    });
    expect(id1).not.toBe(id2);
    const count = (testDb.prepare(`SELECT COUNT(*) AS c FROM events`).get() as { c: number }).c;
    expect(count).toBe(2);
  });

  it('eventRepo.insert extractToolUseId 守门：toolUseId 缺失 / 空串 / 非 string 走普通 INSERT 不 UPSERT（任意多行）', () => {
    // 缺失 toolUseId 字段 → extractToolUseId 返 null → 走普通 INSERT 分支
    const id1 = eventRepoModule.eventRepo.insert({
      sessionId: 'sess-A',
      agentId: 'codex-cli',
      kind: 'tool-use-end',
      payload: { toolName: 'Bash', toolResult: 'no-id' },
      ts: 100,
    });
    // 空串 toolUseId → extractToolUseId 守门返 null
    const id2 = eventRepoModule.eventRepo.insert({
      sessionId: 'sess-A',
      agentId: 'codex-cli',
      kind: 'tool-use-end',
      payload: { toolUseId: '', toolName: 'Bash', toolResult: 'empty-id' },
      ts: 110,
    });
    // 非 string toolUseId (number) → extractToolUseId typeof 守门返 null
    const id3 = eventRepoModule.eventRepo.insert({
      sessionId: 'sess-A',
      agentId: 'codex-cli',
      kind: 'tool-use-end',
      payload: { toolUseId: 123 as unknown as string, toolName: 'Bash', toolResult: 'number-id' },
      ts: 120,
    });

    // 3 行各自新行，无 UPSERT 替换
    expect(new Set([id1, id2, id3]).size).toBe(3);
    const count = (testDb.prepare(`SELECT COUNT(*) AS c FROM events`).get() as { c: number }).c;
    expect(count).toBe(3);
    // tool_use_id 列 5 类非合法值全 NULL
    const nullCol = (
      testDb.prepare(`SELECT COUNT(*) AS c FROM events WHERE tool_use_id IS NULL`).get() as {
        c: number;
      }
    ).c;
    expect(nullCol).toBe(3);
  });

  it('eventRepo.insert 其他 kind（message / file-changed）走普通 INSERT，不参与 UPSERT 路径', () => {
    const id1 = eventRepoModule.eventRepo.insert({
      sessionId: 'sess-A',
      agentId: 'codex-cli',
      kind: 'message',
      payload: { text: 'hello', role: 'assistant' },
      ts: 100,
    });
    const id2 = eventRepoModule.eventRepo.insert({
      sessionId: 'sess-A',
      agentId: 'codex-cli',
      kind: 'message',
      payload: { text: 'world', role: 'assistant' },
      ts: 200,
    });
    expect(id1).not.toBe(id2);
    // message kind 永远新行（无 dedup）
    const count = (
      testDb.prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'message'`).get() as {
        c: number;
      }
    ).c;
    expect(count).toBe(2);
  });

  it('eventRepo.insert safeStringifyPayload：复杂嵌套 payload 不抛错且 round-trip 一致', () => {
    const complexPayload = {
      toolUseId: 'item_complex',
      toolName: 'mcp__foo__bar',
      toolResult: { content: [{ type: 'text', text: 'line1\nline2\t<>&"\'' }], nested: { deep: { value: 42 } } },
      status: 'completed',
    };
    const id = eventRepoModule.eventRepo.insert({
      sessionId: 'sess-A',
      agentId: 'codex-cli',
      kind: 'tool-use-end',
      payload: complexPayload,
      ts: 100,
    });
    const row = testDb.prepare(`SELECT payload_json FROM events WHERE id = ?`).get(id) as {
      payload_json: string;
    };
    expect(JSON.parse(row.payload_json)).toEqual(complexPayload);
  });
});
