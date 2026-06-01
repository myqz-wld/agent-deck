/**
 * REVIEW_91（Batch G4）回归测试 — 同毫秒 ts 排序 tie-breaker。
 *
 * 双 reviewer（claude + codex）独立共识：event-repo 的 findTeamEvents /
 * findLatestAssistantMessage / listForSessionRange 与 summary-repo 的 listForSession /
 * latestForSession / latestForSessions 都缺 `id` 二级键，同毫秒 ts 下 SQLite 返回顺序不稳定。
 *
 * 复发主题：本项目 deep review 已在 team-repo（G2）/ message-repo（G3）/ event-formatter（E2）
 * 三连命中同款，G4 在 store 层补齐 event + summary 剩余查询。
 *
 * 每个 it 都「同毫秒插 ≥2 行，断言取到 id 最大（DESC）/ 最小（ASC，仅 range）那条」。
 * temp-revert 验证：把对应 ORDER BY 的 `, id DESC`/`, id ASC` 去掉，本 test 应 FAIL。
 *
 * 走 vi.mock('@main/store/db') 注入 in-memory testDb + 动态 import 生产 repo 跑真 SQL
 * （harness 模式照搬 v025-migration.test.ts sub-case C）。
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

// vi.mock 闭包 dbHolder：动态 import 的生产 repo 通过 getDb() 拿到本文件注入的 testDb。
const dbHolder: { current: Database.Database | null } = { current: null };
vi.mock('@main/store/db', () => ({
  getDb: () => {
    if (!dbHolder.current) {
      throw new Error('[repo-tiebreaker.test] dbHolder.current 未注入');
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
     VALUES (?, 'codex-cli', '/tmp', ?, 'sdk', 'active', 'idle', ?, ?)`,
  ).run(id, `title-${id}`, 1000, 1000);
}

/** 直接 SQL 插一条 message-kind assistant event，返回自增 id。 */
function insertAssistantMessage(
  db: Database.Database,
  sessionId: string,
  text: string,
  ts: number,
): number {
  const payload = JSON.stringify({ role: 'assistant', text });
  const info = db
    .prepare(`INSERT INTO events (session_id, kind, payload_json, ts) VALUES (?, 'message', ?, ?)`)
    .run(sessionId, payload, ts);
  return Number(info.lastInsertRowid);
}

function insertGenericEvent(
  db: Database.Database,
  sessionId: string,
  kind: string,
  ts: number,
  tag: string,
): number {
  const info = db
    .prepare(`INSERT INTO events (session_id, kind, payload_json, ts) VALUES (?, ?, ?, ?)`)
    .run(sessionId, kind, JSON.stringify({ tag }), ts);
  return Number(info.lastInsertRowid);
}

describe.skipIf(!bindingAvailable)('REVIEW_91 tie-breaker / event-repo', () => {
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

  it('findLatestAssistantMessage 同毫秒取最晚插入（id DESC tie-breaker）', () => {
    insertAssistantMessage(testDb, 'sess-A', 'OLD', 5000);
    insertAssistantMessage(testDb, 'sess-A', 'NEW', 5000); // 同 ts，id 更大 = 更晚
    const latest = mod.eventRepo.findLatestAssistantMessage('sess-A');
    expect(latest?.text).toBe('NEW');
  });

  it('findLatestAssistantMessage sinceTs 分支同样带 tie-breaker', () => {
    insertAssistantMessage(testDb, 'sess-A', 'OLD', 7000);
    insertAssistantMessage(testDb, 'sess-A', 'NEW', 7000);
    const latest = mod.eventRepo.findLatestAssistantMessage('sess-A', 6000);
    expect(latest?.text).toBe('NEW');
  });

  it('listForSessionRange 同毫秒按 id ASC 升序（方向跟 ts ASC 一致）', () => {
    const id1 = insertGenericEvent(testDb, 'sess-A', 'message', 8000, 'first');
    const id2 = insertGenericEvent(testDb, 'sess-A', 'message', 8000, 'second');
    const rows = mod.eventRepo.listForSessionRange('sess-A', 8000, 9000);
    // 同毫秒下应按 id 升序：first(id1) 在 second(id2) 之前
    expect(rows.map((r) => r.id)).toEqual([id1, id2]);
  });

  it('findTeamEvents 同毫秒按 id DESC（跨 session 聚合稳定）', () => {
    // 直接 SQL seed team + active members（绕过 team-repo 的「至少 1 lead」guard，
    // findTeamEvents 只读 listActiveMembers → 直查 agent_deck_team_members left_at IS NULL）。
    insertSession(testDb, 'sess-B');
    const teamId = 'team-tiebreak-0001';
    testDb
      .prepare(`INSERT INTO agent_deck_teams (id, name, created_at) VALUES (?, 'tb', 1000)`)
      .run(teamId);
    testDb
      .prepare(
        `INSERT INTO agent_deck_team_members (team_id, session_id, role, joined_at) VALUES (?, ?, ?, 1000)`,
      )
      .run(teamId, 'sess-A', 'lead');
    testDb
      .prepare(
        `INSERT INTO agent_deck_team_members (team_id, session_id, role, joined_at) VALUES (?, ?, ?, 1000)`,
      )
      .run(teamId, 'sess-B', 'teammate');

    // 同毫秒插两条（不同 session），id 更大者应排在最近（DESC 首位）
    const idEarly = insertGenericEvent(testDb, 'sess-A', 'team-task-created', 9000, 'early');
    const idLate = insertGenericEvent(testDb, 'sess-B', 'team-task-created', 9000, 'late');
    const rows = mod.eventRepo.findTeamEvents(teamId, 50);
    // DESC：id 最大（最晚插入）在数组首位
    expect(rows[0].id).toBe(Math.max(idEarly, idLate));
    expect(rows[0].id).toBe(idLate);
  });
});

describe.skipIf(!bindingAvailable)('REVIEW_91 tie-breaker / summary-repo', () => {
  let testDb: Database.Database;
  let mod: typeof import('../summary-repo');

  beforeEach(async () => {
    testDb = makeDb();
    dbHolder.current = testDb;
    mod = await import('../summary-repo');
    insertSession(testDb, 'sess-A');
  });
  afterEach(() => {
    dbHolder.current = null;
    testDb.close();
  });

  function seedSummary(content: string, ts: number): number {
    return mod.summaryRepo.insert({ sessionId: 'sess-A', content, trigger: 'manual', ts }).id;
  }

  it('latestForSession 同毫秒取最晚插入（id DESC）', () => {
    seedSummary('OLD', 5000);
    seedSummary('NEW', 5000);
    expect(mod.summaryRepo.latestForSession('sess-A')?.content).toBe('NEW');
  });

  it('listForSession 同毫秒按 id DESC 排序稳定', () => {
    const idOld = seedSummary('OLD', 6000);
    const idNew = seedSummary('NEW', 6000);
    const rows = mod.summaryRepo.listForSession('sess-A');
    expect(rows.map((r) => r.id)).toEqual([idNew, idOld]); // DESC：新的在前
  });

  it('latestForSessions 窗口函数同毫秒取最晚插入（PARTITION ORDER BY ts DESC, id DESC）', () => {
    seedSummary('OLD', 7000);
    seedSummary('NEW', 7000);
    const out = mod.summaryRepo.latestForSessions(['sess-A']);
    expect(out['sess-A']?.content).toBe('NEW');
  });
});
