/**
 * REVIEW_91（Batch G4）回归测试 — 同毫秒 ts 排序 tie-breaker。
 *
 * 双 reviewer（claude + codex）独立共识：event-repo 的 findTeamEvents /
 * findLatestAssistantMessage 与 summary-repo 的 listForSession /
 * latestForSession / latestForSessions 都缺 `id` 二级键，同毫秒 ts 下 SQLite 返回顺序不稳定。
 *
 * 复发主题：本项目 deep review 已在 team-repo（G2）/ message-repo（G3）/ event-formatter（E2）
 * 三连命中同款，G4 在 store 层补齐 event + summary 剩余查询。
 *
 * 每个 it 都「同毫秒插 ≥2 行，断言取到 id 最大（DESC）那条」。
 * temp-revert 验证：把对应 ORDER BY 的 `, id DESC` 去掉，本 test 应 FAIL。
 *
 * 走 vi.mock('@main/store/db') 注入 in-memory testDb + 动态 import 生产 repo 跑真 SQL
 * （harness 模式照搬 v025-migration.test.ts sub-case C）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_SQL } from '../schema';

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
  db.exec(CURRENT_SCHEMA_SQL);
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

  it('bounds assistant fallback by captured revision', () => {
    insertAssistantMessage(testDb, 'sess-A', 'OLD', 5_000);
    const captured = (
      testDb.prepare(
        `SELECT revision FROM session_event_revisions WHERE session_id = 'sess-A'`,
      ).get() as { revision: number }
    ).revision;
    insertAssistantMessage(testDb, 'sess-A', 'NEW', 7_000);

    expect(
      mod.eventRepo.findLatestAssistantMessageAtOrBeforeRevision('sess-A', captured)?.text,
    ).toBe('OLD');
    expect(
      mod.eventRepo.findLatestAssistantMessageAtOrBeforeRevision(
        'sess-A',
        captured + 1,
      )?.text,
    ).toBe('NEW');
  });

  it('latestConversationMessageTs ignores non-dialog/error rows and returns the latest dialog time', () => {
    testDb.prepare(
      `INSERT INTO events (session_id, kind, payload_json, ts) VALUES (?, ?, ?, ?)`,
    ).run('sess-A', 'message', JSON.stringify({ role: 'user', text: 'question' }), 5_000);
    testDb.prepare(
      `INSERT INTO events (session_id, kind, payload_json, ts) VALUES (?, ?, ?, ?)`,
    ).run('sess-A', 'message', JSON.stringify({ role: 'assistant', text: 'error', error: true }), 8_000);
    insertGenericEvent(testDb, 'sess-A', 'tool-use-start', 9_000, 'tool');

    expect(mod.eventRepo.latestConversationMessageTs('sess-A')).toBe(5_000);
  });

  it('latestConversationMessageTs and maxEventId return null for an empty session', () => {
    expect(mod.eventRepo.latestConversationMessageTs('sess-A')).toBeNull();
    expect(mod.eventRepo.maxEventId('sess-A')).toBeNull();
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
    return mod.summaryRepo.insert({
      sessionId: 'sess-A',
      content,
      trigger: 'manual',
      ts,
      sourceEventRevision: 0,
      sourceRebuildAfterRevision: 0,
      generationSource: 'llm',
    }).id;
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
