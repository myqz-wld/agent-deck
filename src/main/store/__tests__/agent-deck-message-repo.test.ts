/**
 * agent-deck-message-repo smoke tests（CHANGELOG_105 拆分自 agent-deck-repos.test.ts）。
 *
 * 与 team-repo.test.ts 同 pattern：用 in-memory SQLite + raw migration ?raw import + 共享
 * _setup.ts。bind probe 失败时 skip。
 *
 * 覆盖维度（reviewer 双对抗 ✅ HIGH 修法对应的关键 invariant + 边界）：
 * - message insert：自循环防御 + 100KB 校验
 * - claim 原子化 + retry backoff + MAX_RETRY → failed
 * - crash recovery resetDeliveringOnStartup 不 ++attempt_count（reviewer §4.6 修法）
 * - countPendingForTarget per-target backpressure（reviewer §7.5）
 *
 * agent-deck-team-repo 在同目录 agent-deck-team-repo.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createAgentDeckTeamRepo,
  type AgentDeckTeamRepo,
} from '../agent-deck-team-repo';
import {
  createAgentDeckMessageRepo,
  MessageInvariantError,
  MAX_BODY_LENGTH,
  type AgentDeckMessageRepo,
} from '../agent-deck-message-repo';
import { bindingAvailable, makeMemoryDb, insertSession } from './agent-deck-repos/_setup';

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
    // REVIEW_61 R2 INFO (codex) regression: final retry 必须把 attempt_count 持久化到 DB
    // (旧实现只更新 status/status_reason 不更新 attempt_count → DB 列停在 2 与 reason
    // 字符串 attempt=3 分裂)。R1 fix LOW-α 改成单条 UPDATE 同时写两列,本 test 锁契约。
    expect(r?.attemptCount).toBe(3);
    expect(r?.statusReason).toContain('attempt=3');
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
