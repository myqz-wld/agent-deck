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
import { LIST_EXPIRED_FOR_GC_SQL } from '../agent-deck-message-repo/gc';
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

  it('findEligible 同毫秒 sent_at 用 rowid ASC 锁 FIFO（REVIEW_90 R2 MED 回归）', () => {
    // dispatch FIFO contract: 同毫秒入队多条（含 fresh last_attempt_at=NULL 与 retry 混合）时
    // 纯 ORDER BY sent_at ASC 无 total order — query plan 走 idx_messages_status_last_attempt 后
    // temp sort，同 sent_at tie 受扫描序影响可让后插入的 fresh 排到先插入的 retry 前，违背 FIFO。
    // 修法加 rowid ASC 二级定序（oldest-first）。insert() 无法注入 sent_at/attempt_count，用 raw INSERT。
    const SAME = 1_700_000_000_000;
    // m1: 先插入（rowid 小=oldest），已 retry 一次（attempt=1, last_attempt_at=1000，backoff(1)=1000ms 早已到期）
    db.prepare(
      `INSERT INTO agent_deck_messages
       (id, team_id, from_session_id, to_session_id, body, status, status_reason,
        sent_at, delivered_at, attempt_count, last_attempt_at, delivering_since, reply_to_message_id)
       VALUES ('fe1-old-retry', ?, 'sA', 'sB', 'a', 'pending', NULL, ?, NULL, 1, 1000, NULL, NULL)`,
    ).run(teamId, SAME);
    // m2: 后插入（rowid 大=newer），同毫秒，fresh（attempt=0, last_attempt_at=NULL）
    db.prepare(
      `INSERT INTO agent_deck_messages
       (id, team_id, from_session_id, to_session_id, body, status, status_reason,
        sent_at, delivered_at, attempt_count, last_attempt_at, delivering_since, reply_to_message_id)
       VALUES ('fe2-new-fresh', ?, 'sA', 'sB', 'b', 'pending', NULL, ?, NULL, 0, NULL, NULL, NULL)`,
    ).run(teamId, SAME);
    // m3: 严格更晚 sent_at
    db.prepare(
      `INSERT INTO agent_deck_messages
       (id, team_id, from_session_id, to_session_id, body, status, status_reason,
        sent_at, delivered_at, attempt_count, last_attempt_at, delivering_since, reply_to_message_id)
       VALUES ('fe3-newer', ?, 'sA', 'sB', 'c', 'pending', NULL, ?, NULL, 0, NULL, NULL, NULL)`,
    ).run(teamId, SAME + 1);

    // now=3000：三条都 eligible（m1 retry 退避到期 1000+1000<=3000；m2/m3 fresh）。
    // FIFO 期望同毫秒内 oldest-first：fe1-old-retry（先插）→ fe2-new-fresh（后插）→ fe3-newer（更晚 ms）
    const eligible = msgRepo.findEligible({ now: 3000 }).map((m) => m.id);
    expect(eligible).toEqual(['fe1-old-retry', 'fe2-new-fresh', 'fe3-newer']);

    // findEligibleExcludingTargets 同款 FIFO（取最早一条）：排除 sZ（无关）应仍取 fe1
    const fair = msgRepo.findEligibleExcludingTargets({ now: 3000, excludeTargets: ['sZ-other'] });
    expect(fair?.id).toBe('fe1-old-retry');
  });

  it('listByTeam / listBySession 同毫秒 sent_at 用 rowid DESC 稳定定序（REVIEW_90 MED 回归）', () => {
    // 背靠背 insert 落同一毫秒（insert() 内部 const now = Date.now()）→ 纯 ORDER BY sent_at DESC
    // 无 total order：SQLite 返回插入序(oldest-first)，违背 jsdoc「最新在前」+ 分页 LIMIT/OFFSET
    // 切到同毫秒 tie 组跨页重复/漏行。修法加 rowid DESC 二级排序（必须 rowid 非 id——id 是
    // crypto.randomUUID() 随机；rowid 单调随插入）。insert() 无法注入 sent_at，用 raw INSERT 锁同毫秒。
    const SAME = 1_700_000_000_000;
    const ids = ['mm1', 'mm2', 'mm3', 'mm4', 'mm5'];
    const stmt = db.prepare(
      `INSERT INTO agent_deck_messages
       (id, team_id, from_session_id, to_session_id, body, status, status_reason,
        sent_at, delivered_at, attempt_count, last_attempt_at, delivering_since, reply_to_message_id)
       VALUES (?, ?, 'sA', 'sB', ?, 'pending', NULL, ?, NULL, 0, NULL, NULL, NULL)`,
    );
    for (const id of ids) stmt.run(id, teamId, `body-${id}`, SAME);

    // newest-first（rowid DESC）：插入序 mm1..mm5 → 期望 mm5..mm1
    const expectedDesc = ['mm5', 'mm4', 'mm3', 'mm2', 'mm1'];
    expect(msgRepo.listByTeam(teamId).map((m) => m.id)).toEqual(expectedDesc);
    expect(msgRepo.listBySession('sB').map((m) => m.id)).toEqual(expectedDesc);
    // listBySession 改 UNION ALL 双索引后（plan message-retention-and-index-20260602 D5），子查询
    // SELECT *, rowid AS _rid + 外层 ORDER BY sent_at DESC, _rid DESC 仍保 rowid 二级定序稳定。
    expect(msgRepo.listBySession('sA').map((m) => m.id)).toEqual(expectedDesc);

    // 分页边界稳定：page1(LIMIT2 OFFSET0) + page2(LIMIT2 OFFSET2) 无重复/漏行
    const page1 = msgRepo.listByTeam(teamId, { limit: 2, offset: 0 }).map((m) => m.id);
    const page2 = msgRepo.listByTeam(teamId, { limit: 2, offset: 2 }).map((m) => m.id);
    expect(page1).toEqual(['mm5', 'mm4']);
    expect(page2).toEqual(['mm3', 'mm2']);
    // session 视角分页同款稳定
    const sPage1 = msgRepo.listBySession('sB', { limit: 2, offset: 0 }).map((m) => m.id);
    const sPage2 = msgRepo.listBySession('sB', { limit: 2, offset: 2 }).map((m) => m.id);
    expect(sPage1).toEqual(['mm5', 'mm4']);
    expect(sPage2).toEqual(['mm3', 'mm2']);
  });

  it('CASCADE：删 team 级联删 messages', () => {
    msgRepo.insert({ teamId, fromSessionId: 'sA', toSessionId: 'sB', body: 'hi' });
    expect(msgRepo.listByTeam(teamId)).toHaveLength(1);
    db.prepare(`DELETE FROM agent_deck_teams WHERE id = ?`).run(teamId);
    expect(msgRepo.listByTeam(teamId)).toHaveLength(0);
  });

  // ─── Follow-up #12: findEligibleExcludingTargets repo 层 unit test ───
  // dispatch.ts:50-78 的空数组 fallback(不拼 NOT IN ())/ NOT IN 排除 / FIFO 此前仅集成层覆盖,
  // 补 repo 层直接单测(SQLite 真测)。用 raw INSERT 锁同毫秒 sent_at 验 FIFO(insert() 无法注入
  // sent_at)。
  describe('findEligibleExcludingTargets (Follow-up #12)', () => {
    /** raw INSERT pending message,锁定 sent_at 验 FIFO(同毫秒走 rowid ASC)。 */
    function rawInsert(id: string, toSessionId: string, sentAt: number): void {
      db.prepare(
        `INSERT INTO agent_deck_messages
         (id, team_id, from_session_id, to_session_id, body, status, status_reason,
          sent_at, delivered_at, attempt_count, last_attempt_at, delivering_since, reply_to_message_id)
         VALUES (?, ?, 'sA', ?, ?, 'pending', NULL, ?, NULL, 0, NULL, NULL, NULL)`,
      ).run(id, teamId, toSessionId, `body-${id}`, sentAt);
    }

    it('空 excludeTargets → 退化为 findEligible LIMIT 1(取最早一条,不拼 NOT IN ())', () => {
      const SAME = 1_700_000_000_000;
      rawInsert('e1-oldest', 'sB', SAME);
      rawInsert('e2-newer', 'sB', SAME + 100);
      // 空数组不拼 `NOT IN ()`(SQL 语法非法)→ 等价纯 findEligible 取最早
      const r = msgRepo.findEligibleExcludingTargets({ now: SAME + 1000, excludeTargets: [] });
      expect(r).not.toBeNull();
      expect(r?.id).toBe('e1-oldest');
    });

    it('非空 excludeTargets → NOT IN 正确排除被选 target,取剩余最早一条', () => {
      const SAME = 1_700_000_000_000;
      // 最早的发给 sB(被排除),次早发给 sC(应被选中)
      rawInsert('x1-to-sB', 'sB', SAME);
      rawInsert('x2-to-sC', 'sC', SAME + 100);
      rawInsert('x3-to-sB', 'sB', SAME + 200);
      const r = msgRepo.findEligibleExcludingTargets({
        now: SAME + 1000,
        excludeTargets: ['sB'],
      });
      // sB 全被排除 → 取唯一非排除的 sC
      expect(r?.id).toBe('x2-to-sC');
    });

    it('多 target 排除 → NOT IN (?, ?) 全排除后取剩余最早', () => {
      const SAME = 1_700_000_000_000;
      rawInsert('m1-to-sB', 'sB', SAME);
      rawInsert('m2-to-sC', 'sC', SAME + 100);
      rawInsert('m3-to-sD', 'sD', SAME + 200);
      const r = msgRepo.findEligibleExcludingTargets({
        now: SAME + 1000,
        excludeTargets: ['sB', 'sC'],
      });
      expect(r?.id).toBe('m3-to-sD');
    });

    it('所有 pending 的 target 都被排除 → 返 null', () => {
      const SAME = 1_700_000_000_000;
      rawInsert('o1-to-sB', 'sB', SAME);
      rawInsert('o2-to-sB', 'sB', SAME + 100);
      const r = msgRepo.findEligibleExcludingTargets({
        now: SAME + 1000,
        excludeTargets: ['sB'],
      });
      expect(r).toBeNull();
    });

    it('同毫秒 sent_at 多条非排除 target → rowid ASC 锁 FIFO(取先插入一条)', () => {
      const SAME = 1_700_000_000_000;
      // 同毫秒发给两个不同非排除 target:先插 sC 后插 sD → FIFO 取先插的 sC
      rawInsert('f1-to-sC', 'sC', SAME);
      rawInsert('f2-to-sD', 'sD', SAME);
      const r = msgRepo.findEligibleExcludingTargets({
        now: SAME + 1000,
        excludeTargets: ['sZ-unrelated'],
      });
      expect(r?.id).toBe('f1-to-sC');
    });

    it('无 pending message → 返 null(空数组 fallback 路径也不崩)', () => {
      const r = msgRepo.findEligibleExcludingTargets({ now: Date.now(), excludeTargets: [] });
      expect(r).toBeNull();
    });
  });

  // ─── plan message-retention-and-index-20260602 D5: listBySession UNION ALL self-row guard ───
  describe('listBySession UNION ALL self-row guard (Deep-Review R1 codex HIGH-2)', () => {
    /** raw INSERT 绕过 repo insert 的 from==to throw,模拟 rename collision 造的 self-row。 */
    function rawInsert(id: string, from: string, to: string, sentAt: number, status = 'delivered'): void {
      db.prepare(
        `INSERT INTO agent_deck_messages
         (id, team_id, from_session_id, to_session_id, body, status, status_reason,
          sent_at, delivered_at, attempt_count, last_attempt_at, delivering_since, reply_to_message_id)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, 0, NULL, NULL, NULL)`,
      ).run(id, teamId, from, to, `body-${id}`, status, sentAt);
    }

    it('self-row(from==to,rename collision)只返 1 行不重复(guard 生效,byte-identical baseline OR)', () => {
      const SAME = 1_700_000_000_000;
      // 模拟 rename A→B 把 from=A,to=B 变 from=B,to=B 的 self-row
      rawInsert('self1', 'sSELF', 'sSELF', SAME);
      // baseline OR 查询语义:from=sSELF OR to=sSELF → 该行命中 1 次
      const orCount = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM agent_deck_messages WHERE from_session_id='sSELF' OR to_session_id='sSELF'`,
          )
          .get() as { c: number }
      ).c;
      expect(orCount).toBe(1);
      // UNION ALL + guard 必须也只返 1 行(无 guard 会返 2 行重复 → 违反 N2)
      const view = msgRepo.listBySession('sSELF');
      expect(view).toHaveLength(1);
      expect(view[0].id).toBe('self1');
      // status filter 分支同款 guard
      expect(msgRepo.listBySession('sSELF', { status: 'delivered' })).toHaveLength(1);
    });

    it('guard 不漏正常行：sender-only / receiver-only 各 1 条都在', () => {
      const SAME = 1_700_000_000_000;
      rawInsert('out1', 'sX', 'sB', SAME); // sX 作为 sender
      rawInsert('in1', 'sA', 'sX', SAME + 1); // sX 作为 receiver
      const view = msgRepo.listBySession('sX').map((m) => m.id);
      // 两条都在(out1 from=sX 命中第一分支,in1 to=sX 命中第二分支且 from=sA<>sX 不被 guard 排除)
      expect(view.sort()).toEqual(['in1', 'out1']);
    });
  });

  // ─── plan message-retention-and-index-20260602 D7: retention GC repo ───
  describe('GC: listExpiredForGc + batchHardDelete', () => {
    /** raw INSERT 锁定 status + sent_at（insert() 无法注入）。 */
    function rawInsert(id: string, status: string, sentAt: number, replyTo: string | null = null): void {
      db.prepare(
        `INSERT INTO agent_deck_messages
         (id, team_id, from_session_id, to_session_id, body, status, status_reason,
          sent_at, delivered_at, attempt_count, last_attempt_at, delivering_since, reply_to_message_id)
         VALUES (?, ?, 'sA', 'sB', ?, ?, NULL, ?, NULL, 0, NULL, NULL, ?)`,
      ).run(id, teamId, `body-${id}`, status, sentAt, replyTo);
    }

    const NOW = 1_700_000_000_000;
    const OLD = NOW - 40 * 86400_000; // 40 天前（> 30 天 retention → 超期）
    const FRESH = NOW - 1 * 86400_000; // 1 天前（< 30 天 → 不超期）

    it('terminal(delivered/failed/cancelled)超期删；pending/delivering 超期不删（N4）', () => {
      rawInsert('del-old', 'delivered', OLD);
      rawInsert('fail-old', 'failed', OLD);
      rawInsert('cancel-old', 'cancelled', OLD);
      rawInsert('pending-old', 'pending', OLD); // 在途，永不删
      rawInsert('delivering-old', 'delivering', OLD); // 在途，永不删
      const ids = msgRepo.listExpiredForGc({ retentionDays: 30, now: NOW, limit: 500 });
      expect(ids.sort()).toEqual(['cancel-old', 'del-old', 'fail-old']);
      // pending/delivering 即便超期也不入选
      expect(ids).not.toContain('pending-old');
      expect(ids).not.toContain('delivering-old');
    });

    it('terminal 未超期不删（FRESH < retention）', () => {
      rawInsert('del-fresh', 'delivered', FRESH);
      rawInsert('del-old', 'delivered', OLD);
      const ids = msgRepo.listExpiredForGc({ retentionDays: 30, now: NOW, limit: 500 });
      expect(ids).toEqual(['del-old']);
    });

    it('retentionDays=0 → 空（GC 关闭，防御早退）', () => {
      rawInsert('del-old', 'delivered', OLD);
      expect(msgRepo.listExpiredForGc({ retentionDays: 0, now: NOW, limit: 500 })).toEqual([]);
    });

    it('limit 分批：超期 5 条 limit=2 只返最早 2 条（sent_at ASC）', () => {
      rawInsert('d1', 'delivered', OLD);
      rawInsert('d2', 'delivered', OLD + 1);
      rawInsert('d3', 'delivered', OLD + 2);
      rawInsert('d4', 'delivered', OLD + 3);
      rawInsert('d5', 'delivered', OLD + 4);
      const ids = msgRepo.listExpiredForGc({ retentionDays: 30, now: NOW, limit: 2 });
      expect(ids).toEqual(['d1', 'd2']); // 最早 2 条
    });

    it('batchHardDelete 真删 + 返回删除 id；defense status guard 不删非 terminal', () => {
      rawInsert('del-old', 'delivered', OLD);
      rawInsert('pending-old', 'pending', OLD);
      // 即便误把 pending id 传进来，defense-in-depth status guard 也不删它
      const removed = msgRepo.batchHardDelete(['del-old', 'pending-old']);
      expect(removed).toEqual(['del-old']);
      expect(msgRepo.get('del-old')).toBeNull();
      expect(msgRepo.get('pending-old')).not.toBeNull(); // pending 仍在
    });

    it('reply_to 自引用 FK ON DELETE SET NULL：删父消息后 reply 行 reply_to 变 NULL 且行保留（N5）', () => {
      rawInsert('parent-old', 'delivered', OLD);
      // child 引用 parent；child 本身未超期（FRESH）应保留，仅 reply_to 被 SET NULL
      rawInsert('child-fresh', 'delivered', FRESH, 'parent-old');
      expect(msgRepo.get('child-fresh')?.replyToMessageId).toBe('parent-old');
      const removed = msgRepo.batchHardDelete(['parent-old']);
      expect(removed).toEqual(['parent-old']);
      // child 行保留，reply_to 被 SET NULL
      const child = msgRepo.get('child-fresh');
      expect(child).not.toBeNull();
      expect(child?.replyToMessageId).toBeNull();
    });

    it('GC 查询走 partial index idx_messages_terminal_sent_at：无 SCAN 无 TEMP B-TREE（R1 HIGH-1 + R2 回归）', () => {
      rawInsert('d1', 'delivered', OLD);
      // 跑 gc.ts 的真实 SQL 常量（LIST_EXPIRED_FOR_GC_SQL）的 EXPLAIN，而非测试自写查询
      // （Deep-Review R2 claude LOW：否则 gc.ts literal 漂移无守护，HIGH-1 可静默复活）。
      const threshold = NOW - 30 * 86400_000;
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${LIST_EXPIRED_FOR_GC_SQL}`)
        .all(threshold, 500) as { detail: string }[];
      const detail = plan.map((r) => r.detail).join(' | ');
      // ① 不含全表 SCAN ② 不含 TEMP B-TREE（R1 HIGH-1：status-first 也是 SEARCH 但有 temp sort）
      // ③ 命中 partial index（R2 codex MED：三条合一才锁死回归）
      expect(detail).not.toContain('SCAN agent_deck_messages');
      expect(detail).not.toContain('TEMP B-TREE');
      expect(detail).toContain('idx_messages_terminal_sent_at');
    });
  });
});
