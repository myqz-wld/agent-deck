/**
 * agent-deck-team-repo smoke tests（CHANGELOG_105 拆分自 agent-deck-repos.test.ts）。
 *
 * 与 task-repo.test.ts 同 pattern：用 in-memory SQLite + raw migration ?raw import，
 * 通过 createAgentDeckTeamRepo(db) 工厂注入跑全套用例。bind probe 失败时 skip。
 *
 * 覆盖维度（reviewer 双对抗 ✅ HIGH 修法对应的关键 invariant + 边界）：
 * - team 部分 unique 索引：active 内 unique，archived 允许重名（ADR §2.2 / reviewer finding #4）
 * - ensureByName 并发竞争兜底
 * - addMember rejoin / lead 上限 (10) / 0-lead 兜底
 * - findSharedActiveTeams 多 team 场景（reviewer codex HIGH-1 修法对应）
 * - session_id ON DELETE RESTRICT 不让 hard-delete session（reviewer HIGH-2 修法）
 * - renameWithDb 内迁移 team_members.session_id（plan linked-swimming-platypus 修法）
 *
 * agent-deck-message-repo 在同目录 agent-deck-message-repo.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createAgentDeckTeamRepo,
  TeamInvariantError,
  type AgentDeckTeamRepo,
} from '../agent-deck-team-repo';
import { createAgentDeckMessageRepo } from '../agent-deck-message-repo';
import { renameWithDb } from '../session-repo/rename';
import { bindingAvailable, makeMemoryDb, insertSession } from './agent-deck-repos/_setup';

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

  it('session ON DELETE CASCADE：删 sessions 行自动级联清 team_members（v017 修正 v010 RESTRICT 设计冲突）', () => {
    insertSession(db, 'sA');
    const t = repo.create({ name: 'foo' });
    repo.addMember({ teamId: t.id, sessionId: 'sA', role: 'lead' });
    expect(
      (db.prepare(`SELECT COUNT(*) AS c FROM agent_deck_team_members WHERE session_id = ?`).get('sA') as { c: number }).c,
    ).toBe(1);
    // v017 起 session_id FK ON DELETE CASCADE → 直接 DELETE FROM sessions 不抛 FK
    expect(() => db.prepare(`DELETE FROM sessions WHERE id = ?`).run('sA')).not.toThrow();
    // 自动级联清 team_members rows（不再需要先手动 DELETE FROM agent_deck_team_members）
    expect(
      (db.prepare(`SELECT COUNT(*) AS c FROM agent_deck_team_members WHERE session_id = ?`).get('sA') as { c: number }).c,
    ).toBe(0);
  });

  it('renameWithDb 内迁移 team_members.session_id 让 NEW 续接 OLD lead 角色（plan linked-swimming-platypus 修法）', () => {
    insertSession(db, 'sess-old');
    const t = repo.create({ name: 'review-batch' });
    repo.addMember({ teamId: t.id, sessionId: 'sess-old', role: 'lead' });
    expect(repo.listActiveMembers(t.id).map((m) => m.sessionId)).toEqual(['sess-old']);

    // 模拟 fork rename: NEW 不在 sessions 表，走 toExists=false 分支 INSERT 复制 + 子表迁移 + DELETE OLD
    expect(() => renameWithDb(db, 'sess-old', 'sess-new')).not.toThrow();

    // OLD 已删，NEW 已建
    expect(db.prepare(`SELECT id FROM sessions WHERE id = ?`).get('sess-old')).toBeUndefined();
    expect(db.prepare(`SELECT id FROM sessions WHERE id = ?`).get('sess-new')).toBeDefined();

    // team membership 已迁到 NEW + 仍是 lead 角色（NEW 续接 OLD 在 team 的角色）
    const members = repo.listActiveMembers(t.id);
    expect(members.map((m) => m.sessionId)).toEqual(['sess-new']);
    expect(members[0].role).toBe('lead');
  });

  it('renameWithDb 内迁移 messages.from/to_session_id（保 universal-message-watcher 投递引用）', () => {
    const msgRepo = createAgentDeckMessageRepo(db);
    insertSession(db, 'sA');
    insertSession(db, 'sB');
    insertSession(db, 'sC');
    const t = repo.create({ name: 'msg-test' });
    repo.addMember({ teamId: t.id, sessionId: 'sA', role: 'lead' });
    repo.addMember({ teamId: t.id, sessionId: 'sB', role: 'teammate' });

    // 插一条 sA → sB 和一条 sB → sA 的 message
    msgRepo.insert({ teamId: t.id, fromSessionId: 'sA', toSessionId: 'sB', body: 'hi' });
    msgRepo.insert({ teamId: t.id, fromSessionId: 'sB', toSessionId: 'sA', body: 'reply' });

    renameWithDb(db, 'sA', 'sC');

    // sA 已不在 messages 任何字段；sC 接管 sA 的 sender / receiver 角色
    expect(
      (db.prepare(`SELECT COUNT(*) AS c FROM agent_deck_messages WHERE from_session_id = ?`).get('sA') as { c: number }).c,
    ).toBe(0);
    expect(
      (db.prepare(`SELECT COUNT(*) AS c FROM agent_deck_messages WHERE to_session_id = ?`).get('sA') as { c: number }).c,
    ).toBe(0);
    expect(
      (db.prepare(`SELECT COUNT(*) AS c FROM agent_deck_messages WHERE from_session_id = ?`).get('sC') as { c: number }).c,
    ).toBe(1);
    expect(
      (db.prepare(`SELECT COUNT(*) AS c FROM agent_deck_messages WHERE to_session_id = ?`).get('sC') as { c: number }).c,
    ).toBe(1);
  });

  it('renameWithDb 内迁移 sessions.spawned_by 自引用（保 spawn chain 完整性）', () => {
    insertSession(db, 'parent');
    insertSession(db, 'child');
    db.prepare(`UPDATE sessions SET spawned_by = ?, spawn_depth = 1 WHERE id = ?`).run('parent', 'child');
    expect(
      (db.prepare(`SELECT spawned_by FROM sessions WHERE id = ?`).get('child') as { spawned_by: string }).spawned_by,
    ).toBe('parent');

    renameWithDb(db, 'parent', 'parent-new');

    // child.spawned_by 已迁到 parent-new（不被 ON DELETE SET NULL 自动断链）
    expect(
      (db.prepare(`SELECT spawned_by FROM sessions WHERE id = ?`).get('child') as { spawned_by: string }).spawned_by,
    ).toBe('parent-new');
  });

  // **REVIEW_83 MED 回归 test (reviewer-codex R2 单方 + lead 现场验证)**: renameWithDb 必须迁移
  // tasks.owner_session_id / issues.source_session_id / issues.resolution_session_id /
  // issue_appendices.appended_session_id —— 否则 DELETE OLD 触发 tasks FK ON DELETE CASCADE
  // 物理删 task + issues/appendix FK ON DELETE SET NULL 断归属。清单写于 v021 早于 v023(tasks)/
  // v026(issues) 加 FK,从未补这三表 → rename 违反「OLD 整迁 NEW」不变量(现 latent / 防未来 footgun)。
  it('renameWithDb 内迁移 tasks.owner_session_id（防 DELETE OLD 触发 CASCADE 删 task）REVIEW_83 MED', () => {
    insertSession(db, 'task-old');
    // OLD 拥有一个 personal task
    const taskId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO tasks (id, owner_session_id, team_id, subject, status, priority, created_at, updated_at)
       VALUES (?, ?, NULL, 'do X', 'pending', 5, ?, ?)`,
    ).run(taskId, 'task-old', Date.now(), Date.now());
    expect(
      (db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE owner_session_id = ?`).get('task-old') as { c: number }).c,
    ).toBe(1);

    renameWithDb(db, 'task-old', 'task-new');

    // **关键断言**: task 没被 CASCADE 删,owner 迁到 NEW
    expect(db.prepare(`SELECT id FROM tasks WHERE id = ?`).get(taskId)).toBeDefined();
    expect(
      (db.prepare(`SELECT owner_session_id FROM tasks WHERE id = ?`).get(taskId) as { owner_session_id: string }).owner_session_id,
    ).toBe('task-new');
    // OLD 名下无残留
    expect(
      (db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE owner_session_id = ?`).get('task-old') as { c: number }).c,
    ).toBe(0);
  });

  it('renameWithDb 内迁移 issues source/resolution + appendix appended_session_id（防 DELETE OLD SET NULL 断归属）REVIEW_83 MED', () => {
    insertSession(db, 'iss-old');
    insertSession(db, 'iss-other');
    const issueId = crypto.randomUUID();
    // OLD 既是 source 又是 resolution（自助解决场景）
    db.prepare(
      `INSERT INTO issues (id, title, description, kind, severity, status, source_session_id, resolution_session_id, created_at, updated_at)
       VALUES (?, 'bug', 'desc', 'app-bug', 'medium', 'open', ?, ?, ?, ?)`,
    ).run(issueId, 'iss-old', 'iss-old', Date.now(), Date.now());
    // issue_appendices: PK 是 INTEGER AUTOINCREMENT, body 列, appended_at 列（不是 created_at）
    db.prepare(
      `INSERT INTO issue_appendices (issue_id, body, appended_session_id, appended_at)
       VALUES (?, 'more ctx', ?, ?)`,
    ).run(issueId, 'iss-old', Date.now());
    const appendixId = (
      db.prepare(`SELECT id FROM issue_appendices WHERE issue_id = ?`).get(issueId) as { id: number }
    ).id;

    renameWithDb(db, 'iss-old', 'iss-new');

    // **关键断言**: issue 归属迁到 NEW（没被 SET NULL 断链）
    const issueRow = db
      .prepare(`SELECT source_session_id, resolution_session_id FROM issues WHERE id = ?`)
      .get(issueId) as { source_session_id: string | null; resolution_session_id: string | null };
    expect(issueRow.source_session_id).toBe('iss-new');
    expect(issueRow.resolution_session_id).toBe('iss-new');
    // appendix 快照归属迁到 NEW
    const apxRow = db
      .prepare(`SELECT appended_session_id FROM issue_appendices WHERE id = ?`)
      .get(appendixId) as { appended_session_id: string | null };
    expect(apxRow.appended_session_id).toBe('iss-new');
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

  // REVIEW_35 follow-up A2 R2: 补 findActiveMembershipIn + listActiveMembers JOIN 单测
  it('findActiveMembershipIn — happy path 返 active member', () => {
    insertSession(db, 'sA');
    const t = repo.create({ name: 'foo' });
    repo.addMember({ teamId: t.id, sessionId: 'sA', role: 'lead', displayName: 'Alice' });
    const m = repo.findActiveMembershipIn(t.id, 'sA');
    expect(m).not.toBeNull();
    expect(m?.role).toBe('lead');
    expect(m?.displayName).toBe('Alice');
  });

  it('findActiveMembershipIn — left member 返 null（only active）', () => {
    insertSession(db, 'sA');
    const t = repo.create({ name: 'foo' });
    repo.addMember({ teamId: t.id, sessionId: 'sA', role: 'lead' });
    repo.leaveTeam(t.id, 'sA');
    expect(repo.findActiveMembershipIn(t.id, 'sA')).toBeNull();
  });

  it('findActiveMembershipIn — sessionId 不在 team 返 null', () => {
    insertSession(db, 'sA');
    insertSession(db, 'sB');
    const t = repo.create({ name: 'foo' });
    repo.addMember({ teamId: t.id, sessionId: 'sA', role: 'lead' });
    expect(repo.findActiveMembershipIn(t.id, 'sB')).toBeNull();
  });

  it('findActiveMembershipIn — team 不存在返 null（不抛错）', () => {
    expect(repo.findActiveMembershipIn('no-such-team-id', 'sA')).toBeNull();
  });

  it('listActiveMembers — JOIN sessions.archived_at IS NULL 排除 archived session 的 ghost member', () => {
    // REVIEW_35 LOW-A1：listActiveMembers 加 INNER JOIN sessions 与 countActiveLeads 一致
    insertSession(db, 'sA-active');
    insertSession(db, 'sB-archived');
    // archive sB
    db.prepare(`UPDATE sessions SET archived_at = ? WHERE id = ?`).run(Date.now(), 'sB-archived');
    const t = repo.create({ name: 'foo' });
    repo.addMember({ teamId: t.id, sessionId: 'sA-active', role: 'lead' });
    repo.addMember({ teamId: t.id, sessionId: 'sB-archived', role: 'teammate' });
    // active members 应只返 sA-active（sB-archived 被 JOIN archived_at IS NULL 过滤）
    const active = repo.listActiveMembers(t.id);
    expect(active).toHaveLength(1);
    expect(active[0].sessionId).toBe('sA-active');
    // listAllMembers 不 JOIN（保留所有 row 含 archived session）
    expect(repo.listAllMembers(t.id)).toHaveLength(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// agent-deck-message-repo
// ────────────────────────────────────────────────────────────────────────────

