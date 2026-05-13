/**
 * agent-deck-team-repo + agent-deck-message-repo smoke tests（R3.E3）。
 *
 * 与 task-repo.test.ts 同 pattern：用 in-memory SQLite + raw migration ?raw import，
 * 通过 createXxxRepo(db) 工厂注入跑全套用例。bind probe 失败时 skip。
 *
 * 覆盖维度（reviewer 双对抗 ✅ HIGH 修法对应的关键 invariant + 边界）：
 * - team 部分 unique 索引：active 内 unique，archived 允许重名（ADR §2.2 / reviewer finding #4）
 * - ensureByName 并发竞争兜底
 * - addMember rejoin / lead 上限 (10) / 0-lead 兜底
 * - findSharedActiveTeams 多 team 场景（reviewer codex HIGH-1 修法对应）
 * - session_id ON DELETE RESTRICT 不让 hard-delete session（reviewer HIGH-2 修法）
 * - message insert：自循环防御 + 100KB 校验
 * - claim 原子化 + retry backoff + MAX_RETRY → failed
 * - crash recovery resetDeliveringOnStartup 不 ++attempt_count（reviewer §4.6 修法）
 * - countPendingForTarget per-target backpressure（reviewer §7.5）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import {
  createAgentDeckTeamRepo,
  TeamInvariantError,
  type AgentDeckTeamRepo,
} from '../agent-deck-team-repo';
import {
  createAgentDeckMessageRepo,
  MessageInvariantError,
  MAX_BODY_LENGTH,
  type AgentDeckMessageRepo,
} from '../agent-deck-message-repo';

function probeBetterSqliteBinding(): boolean {
  try {
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch (e) {
    console.warn(
      `[agent-deck-repos.test] better-sqlite3 binding 不可用，跳过本文件全部用例。` +
        `若需本地实测：临时跑 pnpm rebuild better-sqlite3，跑完 pnpm install 还原。原因：${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}
const bindingAvailable = probeBetterSqliteBinding();

function makeMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const sql of [v001, v002, v003, v004, v005, v006, v007, v008, v009, v010, v011]) {
    db.exec(sql);
  }
  return db;
}

function insertSession(db: Database.Database, id: string, agentId = 'claude-code'): void {
  db.prepare(
    `INSERT INTO sessions
     (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES (?, ?, ?, ?, 'sdk', 'active', 'idle', ?, ?)`,
  ).run(id, agentId, '/tmp', `title-${id}`, 1000, 1000);
}

// ────────────────────────────────────────────────────────────────────────────
// agent-deck-team-repo
// ────────────────────────────────────────────────────────────────────────────

describe.skipIf(!bindingAvailable)('agent-deck-team-repo / team CRUD', () => {
  let db: Database.Database;
  let repo: AgentDeckTeamRepo;
  beforeEach(() => {
    db = makeMemoryDb();
    repo = createAgentDeckTeamRepo(db);
  });
  afterEach(() => db.close());

  it('create 自动填 id / createdAt / archivedAt=null / metadata={}', () => {
    const t = repo.create({ name: 'review-X' });
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(t.name).toBe('review-X');
    expect(t.archivedAt).toBeNull();
    expect(t.metadata).toEqual({});
    expect(t.createdAt).toBeGreaterThan(0);
  });

  it('部分 unique：active 内不能重名，archived 允许重名（reviewer finding #4 修法）', () => {
    const t1 = repo.create({ name: 'review-X' });
    expect(() => repo.create({ name: 'review-X' })).toThrow(TeamInvariantError);

    // archive t1 后允许同名 active
    repo.archive(t1.id);
    const t2 = repo.create({ name: 'review-X' });
    expect(t2.id).not.toBe(t1.id);
    expect(t2.archivedAt).toBeNull();

    // 还可再起一个 archived 同名
    const t3 = repo.create({ name: 'review-X' });
    repo.archive(t3.id);
    expect(repo.get(t3.id)?.archivedAt).not.toBeNull();
  });

  it('ensureByName：单方调用建新；并发竞争被部分 unique 拒后回查 winner', () => {
    const t1 = repo.ensureByName('foo');
    const t2 = repo.ensureByName('foo'); // 应该返回同一个
    expect(t2.id).toBe(t1.id);

    // 模拟竞争：手动 INSERT 同名 active 后 ensureByName 兜底
    const otherId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO agent_deck_teams (id, name, created_at) VALUES (?, 'bar', ?)`,
    ).run(otherId, Date.now());
    const t3 = repo.ensureByName('bar');
    expect(t3.id).toBe(otherId);
  });

  it('archive / unarchive：archive 后 listActiveOnly 不返回；unarchive 后回到 active', () => {
    const t = repo.create({ name: 'tmp' });
    repo.archive(t.id);
    expect(repo.list({ activeOnly: true })).toHaveLength(0);
    expect(repo.list({ activeOnly: false })).toHaveLength(1);
    repo.unarchive(t.id);
    expect(repo.list({ activeOnly: true })).toHaveLength(1);
  });

  it('unarchive 时若 active 同名占位则抛 TeamInvariantError', () => {
    const t1 = repo.create({ name: 'X' });
    repo.archive(t1.id);
    repo.create({ name: 'X' }); // 新 active 占位
    expect(() => repo.unarchive(t1.id)).toThrow(TeamInvariantError);
  });

  it('list 默认 activeOnly + 按 createdAt DESC + limit/offset 分页', () => {
    const a = repo.create({ name: 'a' });
    const b = repo.create({ name: 'b' });
    const c = repo.create({ name: 'c' });
    const list = repo.list();
    expect(list.map((t) => t.id)).toEqual([c.id, b.id, a.id]);

    expect(repo.list({ limit: 2 })).toHaveLength(2);
    expect(repo.list({ limit: 2, offset: 1 }).map((t) => t.id)).toEqual([b.id, a.id]);
  });

  it('hardDelete 删 team + CASCADE 清 members（与 sessions ON DELETE RESTRICT 解耦）', () => {
    insertSession(db, 'sess-A');
    const t = repo.create({ name: 'foo' });
    repo.addMember({ teamId: t.id, sessionId: 'sess-A', role: 'lead' });
    expect(repo.listAllMembers(t.id)).toHaveLength(1);
    repo.hardDelete(t.id);
    expect(repo.get(t.id)).toBeNull();
    // CASCADE 清空 members
    expect(repo.listAllMembers(t.id)).toHaveLength(0);
  });

  it('metadata JSON 解析失败时退化空对象（不挂 list）', () => {
    const t = repo.create({ name: 'foo', metadata: { foo: 1 } });
    // 人工写脏数据：直接绕过 CHECK 是不行的（CHECK 会拦），但这里测 row 解析路径的容错
    // 改成用合法 JSON-stringify 的 array（CHECK json_valid 会通过，但 rowToRecord 会 warn 退化）
    db.prepare(`UPDATE agent_deck_teams SET metadata = '[1,2]' WHERE id = ?`).run(t.id);
    const got = repo.get(t.id);
    expect(got?.metadata).toEqual({});
  });
});

describe.skipIf(!bindingAvailable)('agent-deck-team-repo / member CRUD', () => {
  let db: Database.Database;
  let repo: AgentDeckTeamRepo;
  beforeEach(() => {
    db = makeMemoryDb();
    repo = createAgentDeckTeamRepo(db);
  });
  afterEach(() => db.close());

  it('addMember 新建 + countActiveLeads + listActiveMembers', () => {
    insertSession(db, 'sA');
    insertSession(db, 'sB');
    const t = repo.create({ name: 'foo' });
    repo.addMember({ teamId: t.id, sessionId: 'sA', role: 'lead' });
    repo.addMember({ teamId: t.id, sessionId: 'sB', role: 'teammate' });
    expect(repo.countActiveLeads(t.id)).toBe(1);
    expect(repo.listActiveMembers(t.id)).toHaveLength(2);
  });

  it('addMember 同 (team, session) 已 active 抛 TeamInvariantError', () => {
    insertSession(db, 'sA');
    const t = repo.create({ name: 'foo' });
    repo.addMember({ teamId: t.id, sessionId: 'sA', role: 'lead' });
    expect(() => repo.addMember({ teamId: t.id, sessionId: 'sA', role: 'teammate' })).toThrow(
      TeamInvariantError,
    );
  });

  it('leaveTeam 写 left_at 不删 row；rejoin 复用同 PK 行（更新 role/joined_at/left_at=NULL）', () => {
    insertSession(db, 'sA');
    const t = repo.create({ name: 'foo' });
    repo.addMember({ teamId: t.id, sessionId: 'sA', role: 'lead' });
    repo.leaveTeam(t.id, 'sA');
    expect(repo.listActiveMembers(t.id)).toHaveLength(0);
    expect(repo.listAllMembers(t.id)).toHaveLength(1); // 历史保留
    // rejoin
    const rejoined = repo.addMember({ teamId: t.id, sessionId: 'sA', role: 'teammate' });
    expect(rejoined.leftAt).toBeNull();
    expect(rejoined.role).toBe('teammate');
    expect(repo.listActiveMembers(t.id)).toHaveLength(1);
  });

  it('lead 数上限 = 10 / 第 11 个 lead addMember throw（reviewer schema 不变量）', () => {
    const t = repo.create({ name: 'big' });
    for (let i = 0; i < 10; i++) {
      insertSession(db, `s${i}`);
      repo.addMember({ teamId: t.id, sessionId: `s${i}`, role: 'lead' });
    }
    expect(repo.countActiveLeads(t.id)).toBe(10);
    insertSession(db, 's10');
    expect(() => repo.addMember({ teamId: t.id, sessionId: 's10', role: 'lead' })).toThrow(
      TeamInvariantError,
    );
    // 但 teammate 仍可加
    const teammate = repo.addMember({ teamId: t.id, sessionId: 's10', role: 'teammate' });
    expect(teammate.role).toBe('teammate');
  });

  it('setRole：lead → teammate 时若是最后一个 lead 且 active members > 0 则拒', () => {
    insertSession(db, 'sA');
    insertSession(db, 'sB');
    const t = repo.create({ name: 'foo' });
    repo.addMember({ teamId: t.id, sessionId: 'sA', role: 'lead' });
    repo.addMember({ teamId: t.id, sessionId: 'sB', role: 'teammate' });
    expect(() => repo.setRole(t.id, 'sA', 'teammate')).toThrow(TeamInvariantError);

    // 加第二个 lead 后允许 demote 第一个
    insertSession(db, 'sC');
    repo.addMember({ teamId: t.id, sessionId: 'sC', role: 'lead' });
    expect(repo.setRole(t.id, 'sA', 'teammate')?.role).toBe('teammate');
  });

  it('findSharedActiveTeams：多 team 场景（reviewer codex HIGH-1 修法）', () => {
    insertSession(db, 'sA');
    insertSession(db, 'sB');
    insertSession(db, 'sC');
    const t1 = repo.create({ name: 't1' });
    const t2 = repo.create({ name: 't2' });
    const t3 = repo.create({ name: 't3' });

    // sA + sB 共享 t1 + t2；sB + sC 共享 t2；sA + sC 共享无
    repo.addMember({ teamId: t1.id, sessionId: 'sA', role: 'lead' });
    repo.addMember({ teamId: t1.id, sessionId: 'sB', role: 'teammate' });
    repo.addMember({ teamId: t2.id, sessionId: 'sA', role: 'lead' });
    repo.addMember({ teamId: t2.id, sessionId: 'sB', role: 'teammate' });
    repo.addMember({ teamId: t2.id, sessionId: 'sC', role: 'teammate' });
    repo.addMember({ teamId: t3.id, sessionId: 'sA', role: 'lead' });

    expect(repo.findSharedActiveTeams('sA', 'sB').sort()).toEqual([t1.id, t2.id].sort());
    expect(repo.findSharedActiveTeams('sB', 'sC')).toEqual([t2.id]);
    expect(repo.findSharedActiveTeams('sA', 'sC')).toEqual([]);

    // 自循环：同一 session 返回空
    expect(repo.findSharedActiveTeams('sA', 'sA')).toEqual([]);

    // leaveTeam 后该 team 不再共享
    repo.leaveTeam(t1.id, 'sB');
    expect(repo.findSharedActiveTeams('sA', 'sB')).toEqual([t2.id]);
  });

  it('session ON DELETE RESTRICT：删 sessions 行时 team_members 拦截（reviewer HIGH-2 修法）', () => {
    insertSession(db, 'sA');
    const t = repo.create({ name: 'foo' });
    repo.addMember({ teamId: t.id, sessionId: 'sA', role: 'lead' });
    // 直接 DELETE FROM sessions 应失败
    expect(() => db.prepare(`DELETE FROM sessions WHERE id = ?`).run('sA')).toThrow(
      /FOREIGN KEY constraint failed/i,
    );
    // leaveTeam 后理论上 row 仍在（left_at 非 NULL），FK 仍生效 → 仍拦
    repo.leaveTeam(t.id, 'sA');
    expect(() => db.prepare(`DELETE FROM sessions WHERE id = ?`).run('sA')).toThrow(
      /FOREIGN KEY constraint failed/i,
    );
    // 必须先 DELETE FROM agent_deck_team_members 才能删 sessions（sessionManager.delete pre-check 兜底）
    db.prepare(`DELETE FROM agent_deck_team_members WHERE session_id = ?`).run('sA');
    expect(() => db.prepare(`DELETE FROM sessions WHERE id = ?`).run('sA')).not.toThrow();
  });

  it('findActiveMembershipsBySession 仅返回 active', () => {
    insertSession(db, 'sA');
    const t1 = repo.create({ name: 't1' });
    const t2 = repo.create({ name: 't2' });
    repo.addMember({ teamId: t1.id, sessionId: 'sA', role: 'lead' });
    repo.addMember({ teamId: t2.id, sessionId: 'sA', role: 'teammate' });
    expect(repo.findActiveMembershipsBySession('sA')).toHaveLength(2);
    repo.leaveTeam(t1.id, 'sA');
    expect(repo.findActiveMembershipsBySession('sA')).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// agent-deck-message-repo
// ────────────────────────────────────────────────────────────────────────────

describe.skipIf(!bindingAvailable)('agent-deck-message-repo / insert + invariants', () => {
  let db: Database.Database;
  let teamRepo: AgentDeckTeamRepo;
  let msgRepo: AgentDeckMessageRepo;
  let teamId: string;
  beforeEach(() => {
    db = makeMemoryDb();
    teamRepo = createAgentDeckTeamRepo(db);
    msgRepo = createAgentDeckMessageRepo(db);
    insertSession(db, 'sA');
    insertSession(db, 'sB');
    const t = teamRepo.create({ name: 'foo' });
    teamRepo.addMember({ teamId: t.id, sessionId: 'sA', role: 'lead' });
    teamRepo.addMember({ teamId: t.id, sessionId: 'sB', role: 'teammate' });
    teamId = t.id;
  });
  afterEach(() => db.close());

  it('insert 自动填 id / sentAt / status=pending / attemptCount=0', () => {
    const m = msgRepo.insert({ teamId, fromSessionId: 'sA', toSessionId: 'sB', body: 'hi' });
    expect(m.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(m.status).toBe('pending');
    expect(m.attemptCount).toBe(0);
    expect(m.lastAttemptAt).toBeNull();
    expect(m.deliveringSince).toBeNull();
  });

  it('自循环防御：from == to 抛 MessageInvariantError', () => {
    expect(() =>
      msgRepo.insert({ teamId, fromSessionId: 'sA', toSessionId: 'sA', body: 'hi' }),
    ).toThrow(MessageInvariantError);
  });

  it('100KB 边界：恰好 102400 通过；102401 抛（caller-side 校验先于 SQL CHECK）', () => {
    const ok = 'x'.repeat(MAX_BODY_LENGTH);
    expect(() => msgRepo.insert({ teamId, fromSessionId: 'sA', toSessionId: 'sB', body: ok })).not.toThrow();
    const bad = 'x'.repeat(MAX_BODY_LENGTH + 1);
    expect(() =>
      msgRepo.insert({ teamId, fromSessionId: 'sA', toSessionId: 'sB', body: bad }),
    ).toThrow(MessageInvariantError);
  });

  it('空 body 抛', () => {
    expect(() =>
      msgRepo.insert({ teamId, fromSessionId: 'sA', toSessionId: 'sB', body: '' }),
    ).toThrow(MessageInvariantError);
  });
});

describe.skipIf(!bindingAvailable)('agent-deck-message-repo / state machine', () => {
  let db: Database.Database;
  let msgRepo: AgentDeckMessageRepo;
  let teamId: string;
  beforeEach(() => {
    db = makeMemoryDb();
    const teamRepo = createAgentDeckTeamRepo(db);
    msgRepo = createAgentDeckMessageRepo(db);
    insertSession(db, 'sA');
    insertSession(db, 'sB');
    const t = teamRepo.create({ name: 'foo' });
    teamRepo.addMember({ teamId: t.id, sessionId: 'sA', role: 'lead' });
    teamRepo.addMember({ teamId: t.id, sessionId: 'sB', role: 'teammate' });
    teamId = t.id;
  });
  afterEach(() => db.close());

  it('claim 原子化：第一次成功 → status=delivering；第二次返 null', () => {
    const m = msgRepo.insert({ teamId, fromSessionId: 'sA', toSessionId: 'sB', body: 'hi' });
    const claimed = msgRepo.claim(m.id, Date.now());
    expect(claimed?.status).toBe('delivering');
    expect(claimed?.deliveringSince).not.toBeNull();
    expect(claimed?.lastAttemptAt).not.toBeNull();
    expect(msgRepo.claim(m.id, Date.now())).toBeNull();
  });

  it('markDelivered: delivering → delivered（terminal）', () => {
    const m = msgRepo.insert({ teamId, fromSessionId: 'sA', toSessionId: 'sB', body: 'hi' });
    msgRepo.claim(m.id, Date.now());
    const delivered = msgRepo.markDelivered(m.id, Date.now() + 100);
    expect(delivered?.status).toBe('delivered');
    expect(delivered?.deliveredAt).toBeGreaterThan(0);
    expect(delivered?.deliveringSince).toBeNull();
    // 不可再变
    expect(msgRepo.claim(m.id, Date.now())).toBeNull();
    expect(msgRepo.markFailed(m.id, 'late')).toBeNull();
  });

  it('retryAfterFail：attempt_count++ + status=pending；达 MAX_RETRY=3 自动 markFailed', () => {
    const m = msgRepo.insert({ teamId, fromSessionId: 'sA', toSessionId: 'sB', body: 'hi' });
    let now = Date.now();
    // attempt 1
    msgRepo.claim(m.id, now);
    let r = msgRepo.retryAfterFail(m.id, 'err1', now + 100);
    expect(r?.status).toBe('pending');
    expect(r?.attemptCount).toBe(1);
    expect(r?.lastAttemptAt).toBe(now + 100);
    // attempt 2
    now += 5_000;
    msgRepo.claim(m.id, now);
    r = msgRepo.retryAfterFail(m.id, 'err2', now + 100);
    expect(r?.status).toBe('pending');
    expect(r?.attemptCount).toBe(2);
    // attempt 3 → failed（attempt_count >= MAX_RETRY 触发 markFailed）
    now += 10_000;
    msgRepo.claim(m.id, now);
    r = msgRepo.retryAfterFail(m.id, 'err3', now + 100);
    expect(r?.status).toBe('failed');
    expect(r?.statusReason).toContain('retry-exhausted');
  });

  it('findEligible 按 last_attempt_at + backoff 退避（reviewer HIGH-1 修法）', () => {
    const t0 = Date.now();
    const m1 = msgRepo.insert({ teamId, fromSessionId: 'sA', toSessionId: 'sB', body: 'a' });
    const m2 = msgRepo.insert({ teamId, fromSessionId: 'sA', toSessionId: 'sB', body: 'b' });

    // attempt_count=0 + last_attempt_at=null → 都 eligible
    expect(msgRepo.findEligible({ now: t0 })).toHaveLength(2);

    // m1 进 attempt_count=1, last_attempt_at=t0+100
    msgRepo.claim(m1.id, t0);
    msgRepo.retryAfterFail(m1.id, 'err', t0 + 100);

    // 此时 m1 attempt=1, last_attempt_at=t0+100, backoff(1)=1000ms
    // 在 t0+200（< t0+100+1000）时 m1 不 eligible，只有 m2
    const eligibleAtT0p200 = msgRepo.findEligible({ now: t0 + 200 });
    expect(eligibleAtT0p200.map((r) => r.id)).toEqual([m2.id]);

    // 在 t0+1500 (> t0+100+1000) 时 m1 重新 eligible
    const eligibleAtT0p1500 = msgRepo.findEligible({ now: t0 + 1500 });
    expect(eligibleAtT0p1500.map((r) => r.id).sort()).toEqual([m1.id, m2.id].sort());
  });

  it('cancel：pending → cancelled；terminal 状态不可再 cancel', () => {
    const m = msgRepo.insert({ teamId, fromSessionId: 'sA', toSessionId: 'sB', body: 'hi' });
    const cancelled = msgRepo.cancel(m.id, 'lead-revoked');
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.statusReason).toBe('lead-revoked');
    // 二次 cancel 返 null（terminal）
    expect(msgRepo.cancel(m.id, 'again')).toBeNull();
  });

  it('countPendingForTarget：pending + delivering 都计入（reviewer §7.5 backpressure）', () => {
    const m1 = msgRepo.insert({ teamId, fromSessionId: 'sA', toSessionId: 'sB', body: 'a' });
    msgRepo.insert({ teamId, fromSessionId: 'sA', toSessionId: 'sB', body: 'b' });
    msgRepo.insert({ teamId, fromSessionId: 'sA', toSessionId: 'sB', body: 'c' });
    expect(msgRepo.countPendingForTarget('sB')).toBe(3);

    // claim m1 → delivering：仍计入
    msgRepo.claim(m1.id, Date.now());
    expect(msgRepo.countPendingForTarget('sB')).toBe(3);

    // markDelivered m1 → 不计入
    msgRepo.markDelivered(m1.id, Date.now() + 100);
    expect(msgRepo.countPendingForTarget('sB')).toBe(2);
  });

  it('resetDeliveringOnStartup：crash recovery 不 ++attempt_count（reviewer §4.6 修法）', () => {
    const m = msgRepo.insert({ teamId, fromSessionId: 'sA', toSessionId: 'sB', body: 'hi' });
    msgRepo.claim(m.id, Date.now());
    expect(msgRepo.get(m.id)?.status).toBe('delivering');
    expect(msgRepo.get(m.id)?.attemptCount).toBe(0);

    const reset = msgRepo.resetDeliveringOnStartup();
    expect(reset).toBe(1);
    const after = msgRepo.get(m.id);
    expect(after?.status).toBe('pending');
    expect(after?.attemptCount).toBe(0); // 关键：不 ++
    expect(after?.deliveringSince).toBeNull();
    expect(after?.statusReason).toContain('recovered-from-delivering');
  });

  it('listByTeam 按 sentAt DESC + 状态过滤', async () => {
    const m1 = msgRepo.insert({ teamId, fromSessionId: 'sA', toSessionId: 'sB', body: 'a' });
    await new Promise((r) => setTimeout(r, 5)); // 保证 sentAt 不同
    const m2 = msgRepo.insert({ teamId, fromSessionId: 'sA', toSessionId: 'sB', body: 'b' });
    msgRepo.claim(m2.id, Date.now());
    msgRepo.markDelivered(m2.id, Date.now() + 100);

    expect(msgRepo.listByTeam(teamId).map((m) => m.id)).toEqual([m2.id, m1.id]);
    expect(msgRepo.listByTeam(teamId, { status: 'delivered' })).toHaveLength(1);
    expect(msgRepo.listByTeam(teamId, { status: 'pending' })).toHaveLength(1);
  });

  it('listBySession 按 from_session_id OR to_session_id + sentAt DESC（plan mcp-bug-and-feature-batch-20260513 Phase 5 Step 5.2）', async () => {
    // sA → sB
    const m1 = msgRepo.insert({ teamId, fromSessionId: 'sA', toSessionId: 'sB', body: 'a' });
    await new Promise((r) => setTimeout(r, 5));
    // sB → sC（sB 是 sender）
    const m2 = msgRepo.insert({ teamId, fromSessionId: 'sB', toSessionId: 'sC', body: 'b' });
    await new Promise((r) => setTimeout(r, 5));
    // sC → sA（与 sB 完全无关）
    msgRepo.insert({ teamId, fromSessionId: 'sC', toSessionId: 'sA', body: 'c' });

    // sB 视角应拿 m1（被 sA 发到 sB）+ m2（sB 发出去）共 2 条；m3 与 sB 无关不返回
    const sBView = msgRepo.listBySession('sB');
    expect(sBView.map((m) => m.id)).toEqual([m2.id, m1.id]);

    // status 过滤生效
    msgRepo.claim(m1.id, Date.now());
    msgRepo.markDelivered(m1.id, Date.now() + 100);
    expect(msgRepo.listBySession('sB', { status: 'delivered' }).map((m) => m.id)).toEqual([m1.id]);
    expect(msgRepo.listBySession('sB', { status: 'pending' }).map((m) => m.id)).toEqual([m2.id]);

    // limit 透传 + 不存在 session 返回空
    expect(msgRepo.listBySession('sB', { limit: 1 })).toHaveLength(1);
    expect(msgRepo.listBySession('sZZZ-no-such')).toHaveLength(0);
  });

  it('CASCADE：删 team 级联删 messages', () => {
    msgRepo.insert({ teamId, fromSessionId: 'sA', toSessionId: 'sB', body: 'hi' });
    expect(msgRepo.listByTeam(teamId)).toHaveLength(1);
    db.prepare(`DELETE FROM agent_deck_teams WHERE id = ?`).run(teamId);
    expect(msgRepo.listByTeam(teamId)).toHaveLength(0);
  });
});
