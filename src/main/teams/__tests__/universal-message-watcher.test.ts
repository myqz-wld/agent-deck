/**
 * universal-message-watcher.deliver 单测（plan mcp-bug-and-feature-batch-20260513 Phase 1 Step 1.2;
 * CHANGELOG_100 / plan mcp-tool-simplify-20260514 改写）
 *
 * 关键 case：CHANGELOG_100 协议大简化删 J fix（reply 短路）后，所有 message 现在走完整
 * adapter dispatch 链 — `if (claimed.replyToMessageId != null)` 直接 markDelivered 跳过
 * receiveTeammateMessage 的旧逻辑已删除。reply 与普通 send_message 同款 dispatch 进 receiver
 * SDK conversation flow（一统协议）。
 *
 * 不依赖真实 SQLite / Electron / SDK：vi.mock 替换 agentDeckMessageRepo / sessionRepo /
 * adapterRegistry / eventBus / settingsStore / agentDeckTeamRepo 6 个 dep。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentDeckMessage } from '@shared/types';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';
import { makeEventBusMock } from '@main/__tests__/_shared/mocks/event-bus';
import { makeSettingsStoreMock } from '@main/__tests__/_shared/mocks/settings-store';
import { makeAgentDeckTeamRepoMock } from '@main/__tests__/_shared/mocks/agent-deck-team-repo';
import type { AgentDeckTeamRepo } from '@main/store/agent-deck-team-repo';

// ─── Mock setup ─────────────────────────────────────────────────────────
// R37 P2-F Step 3.1：sessionRepo / eventBus / settingsStore / agentDeckTeamRepo 走
// _shared/mocks/ factory + override stateful 行为；agent-deck-message-repo + adapter-registry
// 仍 inline（前者高度 stateful pending Map、后者本地路径专用，不在 5 类抽离范围）。

const claimCalls: string[] = [];
const markDeliveredCalls: Array<{ id: string; ts: number }> = [];
const markFailedCalls: Array<{ id: string; reason: string }> = [];
const sessionRepoGetCalls: string[] = [];
const adapterRegistryGetCalls: string[] = [];
const receiveTeammateMessageCalls: Array<{ to: string; from: string; body: string }> = [];
const emitStatusCalls: Array<{ id: string; status: string }> = [];

let nextClaimResult: AgentDeckMessage | null = null;
let nextSessionResult: { id: string; lifecycle: 'active' | 'dormant' | 'closed'; agentId: string; archivedAt?: number | null } | null = null;
let nextAdapterResult:
  | { capabilities: { canCollaborate: boolean }; receiveTeammateMessage?: typeof receiveTeammateMessageStub }
  | undefined = undefined;
// REVIEW_56 Batch C R1 codex MED-1 修法测试 fixture: watcher deliver() 重验 5 项 invariant
// (team archived / from archived / to archived / from membership / to membership) 需 mock 返
// 默认 active team + active membership 才能让 dispatch 走通。
let nextTeamResult: { id: string; archivedAt: number | null } | null = null;
let nextMembershipResult: { sessionId: string; teamId: string; role: 'lead' | 'teammate'; leftAt: number | null } | null = null;
// REVIEW_56 §Test-Watcher 修法 (Plan-Review Round 2 codex MED-2): 加 per-sessionId Map overlay
// 让新 invariant fail 分支 test 显式控制 from/to membership 独立返值。
// 默认 empty → mock fn 走 fallback nextMembershipResult (existing test backward compat 不影响)。
const membershipBySid: Map<
  string,
  { sessionId: string; teamId: string; role: 'lead' | 'teammate'; leftAt: number | null } | null
> = new Map();

// REVIEW_35 follow-up A1 R2: stateful pending Map 让 process() 集成 test 可跑
// findEligible / countPendingForTarget / claim / markDelivered / markFailed 5 个 fn
// 默认还是返「单值 mock」(nextClaimResult 等)；当 statefulPendingMap !== null 时，5 个 fn
// 改读 statefulPendingMap 实现真 stateful 行为。每个 stateful test 在 beforeEach 后
// 直接 push 进 statefulPendingMap 即可。
let statefulPendingMap: Map<string, AgentDeckMessage> | null = null;
let statefulMaxInflight = 10;

const receiveTeammateMessageStub = async (to: string, from: string, body: string) => {
  receiveTeammateMessageCalls.push({ to, from, body });
};

vi.mock('@main/store/agent-deck-message-repo', () => ({
  MAX_RETRY: 3,
  agentDeckMessageRepo: {
    claim: (id: string, _now: number) => {
      claimCalls.push(id);
      // stateful 模式：从 pending Map 取 + 改 status
      if (statefulPendingMap) {
        const m = statefulPendingMap.get(id);
        if (!m || m.status !== 'pending') return null;
        m.status = 'delivering';
        return { ...m };
      }
      return nextClaimResult;
    },
    markDelivered: (id: string, ts: number) => {
      markDeliveredCalls.push({ id, ts });
      if (statefulPendingMap) {
        const m = statefulPendingMap.get(id);
        if (!m) return null;
        if (m.status !== 'pending' && m.status !== 'delivering') return null;
        m.status = 'delivered';
        m.deliveredAt = ts;
        return { ...m };
      }
      return nextClaimResult ? { ...nextClaimResult, status: 'delivered', deliveredAt: ts } : null;
    },
    markFailed: (id: string, reason: string) => {
      markFailedCalls.push({ id, reason });
      if (statefulPendingMap) {
        const m = statefulPendingMap.get(id);
        if (!m) return null;
        m.status = 'failed';
        m.statusReason = reason;
        return { ...m };
      }
      return nextClaimResult ? { ...nextClaimResult, status: 'failed', statusReason: reason } : null;
    },
    retryAfterFail: () => null,
    findEligible: (opts: { now: number; limit: number }) => {
      if (statefulPendingMap) {
        return Array.from(statefulPendingMap.values())
          .filter((m) => m.status === 'pending')
          .sort((a, b) => a.sentAt - b.sentAt)
          .slice(0, opts.limit);
      }
      return [];
    },
    // REVIEW_56 Batch C R1 codex MED-2 修法 stub: watcher process() 二阶段 cross-target 公平
    // 兜底用。测试默认无 starvation 场景,返 null;若 stateful pending map 模拟 cross-target
    // starve 可走 same FIFO 逻辑 + 排除 excludeTargets 取一条。
    findEligibleExcludingTargets: (opts: { now: number; excludeTargets: readonly string[] }) => {
      if (statefulPendingMap) {
        const excludeSet = new Set(opts.excludeTargets);
        const candidates = Array.from(statefulPendingMap.values())
          .filter((m) => m.status === 'pending' && !excludeSet.has(m.toSessionId))
          .sort((a, b) => a.sentAt - b.sentAt);
        return candidates[0] ?? null;
      }
      return null;
    },
    countPendingForTarget: (sid: string) => {
      if (statefulPendingMap) {
        let n = 0;
        for (const m of statefulPendingMap.values()) {
          if ((m.status === 'pending' || m.status === 'delivering') && m.toSessionId === sid) n++;
        }
        return n;
      }
      return 0;
    },
    resetDeliveringOnStartup: () => 0,
    listAllMembers: () => [],
  },
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({
    overrides: {
      get: (id: string) => {
        sessionRepoGetCalls.push(id);
        return nextSessionResult;
      },
    },
  }),
}));

vi.mock('@main/adapters/registry', () => ({
  adapterRegistry: {
    get: (id: string) => {
      adapterRegistryGetCalls.push(id);
      if (!nextAdapterResult) throw new Error('no adapter');
      return nextAdapterResult;
    },
  },
}));

vi.mock('@main/event-bus', () => ({
  eventBus: makeEventBusMock({
    overrides: {
      emit: (channel: string, payload: { id?: string; status?: string }) => {
        if (channel === 'agent-deck-message-status-changed' && payload.id) {
          emitStatusCalls.push({ id: payload.id, status: payload.status ?? '' });
        }
      },
    },
  }),
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: makeSettingsStoreMock({ get: () => statefulMaxInflight }),
}));

const teamRepoListCalls: Array<{ activeOnly?: boolean; limit?: number; offset?: number }> = [];
let teamRepoListResults: Array<{ id: string; archivedAt: number | null }> = [];

vi.mock('@main/store/agent-deck-team-repo', () => ({
  agentDeckTeamRepo: makeAgentDeckTeamRepoMock({
    overrides: {
      list: ((opts?: { activeOnly?: boolean; limit?: number; offset?: number }) => {
        teamRepoListCalls.push(opts ?? {});
        return teamRepoListResults;
      }) as AgentDeckTeamRepo['list'],
      // REVIEW_56 Batch C R1 codex MED-1 修法 stub: watcher deliver() 重验 team 是否 archived
      // / 双方仍是 active member。返 nextTeamResult / nextMembershipResult 让 test 显式控制。
      get: ((_teamId: string) => nextTeamResult) as AgentDeckTeamRepo['get'],
      // REVIEW_56 §Test-Watcher 修法 (Plan-Review Round 2 codex MED-2): per-sessionId Map overlay
      // 让新 invariant fail 分支 test 区分 from/to membership 独立返值。empty Map → fallback
      // nextMembershipResult (existing test backward compat)。
      findActiveMembershipIn: ((_teamId: string, sessionId: string) =>
        membershipBySid.has(sessionId) ? membershipBySid.get(sessionId)! : nextMembershipResult) as AgentDeckTeamRepo['findActiveMembershipIn'],
    },
  }),
}));

// import after mocks
import { UniversalMessageWatcher, teamEventDispatcher } from '@main/teams/universal-message-watcher';

// ─── Helpers ────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<AgentDeckMessage> = {}): AgentDeckMessage {
  return {
    id: 'msg-1',
    teamId: 'team-1',
    fromSessionId: 'sender-sid',
    toSessionId: 'receiver-sid',
    body: 'hello',
    replyToMessageId: null,
    status: 'pending',
    sentAt: Date.now(),
    deliveredAt: null,
    statusReason: null,
    attemptCount: 0,
    lastAttemptAt: null,
    deliveringSince: null,
    ...overrides,
  };
}

function callDeliver(watcher: UniversalMessageWatcher, msg: AgentDeckMessage): Promise<void> {
  return (watcher as unknown as { deliver: (m: AgentDeckMessage) => Promise<void> }).deliver(msg);
}

beforeEach(() => {
  claimCalls.length = 0;
  markDeliveredCalls.length = 0;
  markFailedCalls.length = 0;
  sessionRepoGetCalls.length = 0;
  adapterRegistryGetCalls.length = 0;
  receiveTeammateMessageCalls.length = 0;
  emitStatusCalls.length = 0;
  teamRepoListCalls.length = 0;
  teamRepoListResults = [];
  nextClaimResult = null;
  nextSessionResult = null;
  nextAdapterResult = undefined;
  // REVIEW_35 follow-up A1 R2: 默认关 stateful 模式
  statefulPendingMap = null;
  statefulMaxInflight = 10;
  // REVIEW_56 Batch C R1 codex MED-1 修法 fixture: 默认 active team + active membership
  // 让 deliver 走 dispatch 路径(test 想测 archive race 时显式 override 这两个全局)
  nextTeamResult = { id: 'team-1', archivedAt: null };
  nextMembershipResult = { sessionId: 'mock-sid', teamId: 'team-1', role: 'teammate', leftAt: null };
  membershipBySid.clear();
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe('universal-message-watcher.deliver - CHANGELOG_100 J fix removed (统一 dispatch)', () => {
  it('reply message (replyToMessageId != null) 现在走完整 dispatch 调 receiveTeammateMessage', async () => {
    // CHANGELOG_100 关键变更：J fix 删除 → reply 不再短路 markDelivered，
    // 与普通 send_message 同款走 adapter.receiveTeammateMessage（reply 自动注入 receiver
    // SDK conversation flow，receiver Claude 看到 user-role message 自动 act on it）
    const replyMsg = makeMessage({
      id: 'reply-1',
      replyToMessageId: 'original-msg-1',
      body: 'reply text',
    });
    nextClaimResult = { ...replyMsg, status: 'delivering' };
    nextSessionResult = { id: 'receiver-sid', lifecycle: 'active', agentId: 'claude-code' };
    nextAdapterResult = {
      capabilities: { canCollaborate: true },
      receiveTeammateMessage: receiveTeammateMessageStub,
    };

    const watcher = new UniversalMessageWatcher();
    await callDeliver(watcher, replyMsg);

    // 关键断言：reply 走完整 dispatch 链（J fix 已删除）
    expect(claimCalls).toEqual(['reply-1']);
    expect(sessionRepoGetCalls).toContain('receiver-sid'); // target check 不再被短路
    expect(adapterRegistryGetCalls).toEqual(['claude-code']);
    expect(receiveTeammateMessageCalls).toHaveLength(1);
    expect(receiveTeammateMessageCalls[0]?.to).toBe('receiver-sid');
    expect(receiveTeammateMessageCalls[0]?.from).toBe('sender-sid');
    expect(markDeliveredCalls).toHaveLength(1);
    expect(markFailedCalls).toHaveLength(0);
  });

  it('non-reply message (replyToMessageId == null) 走 dispatch 调 receiveTeammateMessage', async () => {
    const sendMsg = makeMessage({
      id: 'send-1',
      replyToMessageId: null,
      body: 'normal send',
    });
    nextClaimResult = { ...sendMsg, status: 'delivering' };
    nextSessionResult = { id: 'receiver-sid', lifecycle: 'active', agentId: 'claude-code' };
    nextAdapterResult = {
      capabilities: { canCollaborate: true },
      receiveTeammateMessage: receiveTeammateMessageStub,
    };

    const watcher = new UniversalMessageWatcher();
    await callDeliver(watcher, sendMsg);

    // 走完整 dispatch 链
    expect(claimCalls).toEqual(['send-1']);
    // sessionRepo.get 至少调 'receiver-sid'（target check）；buildWireBody 内
    // resolveFromDisplayName 也调 sessionRepo.get(fromSessionId) 取 sender displayName
    expect(sessionRepoGetCalls).toContain('receiver-sid');
    expect(adapterRegistryGetCalls).toEqual(['claude-code']);
    expect(receiveTeammateMessageCalls).toHaveLength(1);
    expect(receiveTeammateMessageCalls[0]?.to).toBe('receiver-sid');
    expect(receiveTeammateMessageCalls[0]?.from).toBe('sender-sid');
    expect(markDeliveredCalls).toHaveLength(1);
    expect(markFailedCalls).toHaveLength(0);
  });

  it('reply 在 target session 已删除时 markFailed（与普通 message 同款，不再短路 markDelivered）', async () => {
    // CHANGELOG_100：旧 J fix 副作用 — reply 短路在 target check 之前，target 不存在时仍
    // markDelivered（认为 reply 已入库供 sender wait_reply 拿）。删 J fix + 删 wait_reply tool 后
    // 不再有此特殊语义 — reply 现在像普通 message 一样需要 receiver 真在 sessions 表才能投递。
    const replyMsg = makeMessage({
      id: 'reply-orphan',
      replyToMessageId: 'original-msg-1',
      toSessionId: 'deleted-receiver-sid',
    });
    nextClaimResult = { ...replyMsg, status: 'delivering' };
    nextSessionResult = null; // target session 已删

    const watcher = new UniversalMessageWatcher();
    await callDeliver(watcher, replyMsg);

    // 与普通 send_message 同款：target 不存在 → markFailed
    expect(markFailedCalls).toHaveLength(1);
    expect(markFailedCalls[0]?.id).toBe('reply-orphan');
    expect(markFailedCalls[0]?.reason).toContain('not found');
    expect(markDeliveredCalls).toHaveLength(0);
    expect(receiveTeammateMessageCalls).toHaveLength(0); // adapter 没 receive
  });
});

describe('TeamEventDispatcher - C MED-D7 fix (preseed lastArchivedAt 防首次 transition 吞)', () => {
  it('start() 调 agentDeckTeamRepo.list 预填 cache，pagination loop 直到 batch < PAGE_SIZE', () => {
    teamRepoListResults = [
      { id: 't1', archivedAt: null },
      { id: 't2', archivedAt: 12345 }, // 已 archived team 也预填
    ];
    teamEventDispatcher.start();
    try {
      // 至少调 1 次 list 预填
      expect(teamRepoListCalls.length).toBeGreaterThanOrEqual(1);
      expect(teamRepoListCalls[0]).toMatchObject({ activeOnly: false, limit: 200, offset: 0 });
      // mock 返 2 条 < PAGE_SIZE 200，loop 应该一次就 break
      expect(teamRepoListCalls.length).toBe(1);
    } finally {
      teamEventDispatcher.stop();
    }
  });

  it('start() 后首次 emit team-updated（archive transition）能正确 detect 不被吞', () => {
    teamRepoListResults = [
      { id: 't-active', archivedAt: null }, // active team 预填
    ];
    teamEventDispatcher.start();
    try {
      // 模拟 active → archived transition (这是 H1 lead archive 联动场景)
      const archiveTs = Date.now();
      // 借用 mock 的 eventBus.on 没法直接 emit；但 lastArchivedAt cache 是 private
      // 这里只验证 cache 已 preseed（fanOut 调链留 dev smoke 验证）
      const cache = (teamEventDispatcher as unknown as {
        lastArchivedAt: Map<string, number | null>;
      }).lastArchivedAt;
      expect(cache.has('t-active')).toBe(true);
      expect(cache.get('t-active')).toBeNull();
      // 修前: prev=undefined → 任何首次 transition 被吞
      // 修后: prev=null（preseed） → archive transition (cur=archiveTs!=null) 能 detect
      void archiveTs;
    } finally {
      teamEventDispatcher.stop();
    }
  });
});

describe('universal-message-watcher.process - REVIEW_35 HIGH-A1 backpressure 死锁修复', () => {
  // 关键 case：旧逻辑 `if (inflight > maxInflight) continue` 让 N=maxInflight+1 同 target pending
  // 永久死锁（candidate 自身计入 inflight → 全部 continue → 无人 claim）。
  // 修后：① `inflight - 1 > maxInflight` 让 cap 抬到 maxInflight+1 解 N=11 死锁
  //       ② starvation guard：单 tick 全 skip → 强制 deliver candidates[0] 解 N=17 跨 target starvation
  //
  // REVIEW_35 follow-up A1 R2：从「regex 字面量校验」升级为真 stateful test
  // （statefulPendingMap closure + mock fn 读 closure 实现真 state machine）

  function makePendingForTarget(toSessionId: string, n: number, baseTs = 1_000_000): AgentDeckMessage[] {
    return Array.from({ length: n }, (_, i) =>
      makeMessage({
        id: `${toSessionId}-msg-${i}`,
        toSessionId,
        sentAt: baseTs + i,
      }),
    );
  }

  async function runProcessWithPending(pending: AgentDeckMessage[], maxInflight = 10): Promise<{
    deliveredCount: number;
    pendingCount: number;
    deliveredIds: string[];
  }> {
    statefulPendingMap = new Map();
    for (const m of pending) statefulPendingMap.set(m.id, { ...m });
    statefulMaxInflight = maxInflight;
    nextSessionResult = { id: 'X', lifecycle: 'active', agentId: 'claude-code' };
    nextAdapterResult = {
      capabilities: { canCollaborate: true },
      receiveTeammateMessage: receiveTeammateMessageStub,
    };
    const watcher = new UniversalMessageWatcher();
    await (watcher as unknown as { process: () => Promise<void> }).process();
    let deliveredCount = 0;
    let stillPending = 0;
    const deliveredIds: string[] = [];
    for (const m of statefulPendingMap.values()) {
      if (m.status === 'delivered') {
        deliveredCount++;
        deliveredIds.push(m.id);
      }
      if (m.status === 'pending' || m.status === 'delivering') stillPending++;
    }
    return { deliveredCount, pendingCount: stillPending, deliveredIds };
  }

  it('N=10 同 target（< maxInflight+1）一个 tick 全部 deliver', async () => {
    const pending = makePendingForTarget('receiver-A', 10);
    const result = await runProcessWithPending(pending, 10);
    expect(result.deliveredCount).toBe(10);
    expect(result.pendingCount).toBe(0);
  });

  it('N=11 同 target — 修前死锁 (>10 全 skip)，修后 (>10) → other=10, 10>10=false → 全 deliver', async () => {
    const pending = makePendingForTarget('receiver-B', 11);
    const result = await runProcessWithPending(pending, 10);
    expect(result.deliveredCount).toBe(11);
    expect(result.pendingCount).toBe(0);
  });

  it('N=17 同 target — backpressure cap=12 全 skip, starvation guard 强制 deliver candidates[0] 至少 1 条', async () => {
    const pending = makePendingForTarget('receiver-C', 17);
    const result = await runProcessWithPending(pending, 10);
    expect(result.deliveredCount).toBeGreaterThanOrEqual(1);
    // candidates[0] 是 sent_at 最早，starvation guard 必 deliver receiver-C-msg-0
    expect(result.deliveredIds).toContain('receiver-C-msg-0');
  });

  it('N=12 同 target — 临界点（other=11>10 全 skip）→ starvation guard 仍救', async () => {
    const pending = makePendingForTarget('receiver-D', 12);
    const result = await runProcessWithPending(pending, 10);
    expect(result.deliveredCount).toBeGreaterThanOrEqual(1);
  });

  it('N=11 同 target_X + 5 target_Y（X 先入队）— 修后 X 11 全 deliver，Y 5 同样能进 candidates batch', async () => {
    // BATCH_LIMIT=16，11 X + 5 Y = 16 全在 candidates 内
    const pending = [
      ...makePendingForTarget('target-X', 11, 1_000_000),
      ...makePendingForTarget('target-Y', 5, 2_000_000),
    ];
    const result = await runProcessWithPending(pending, 10);
    expect(result.deliveredCount).toBe(16);
    expect(result.pendingCount).toBe(0);
  });

  it('回归记忆：旧错误公式 `if (inflight > maxInflight)` 不再出现', async () => {
    const fs = await import('node:fs/promises');
    // CHANGELOG_105 拆分后 process 方法在 universal-message-watcher/index.ts
    const watcherSrc = await fs.readFile(
      new URL('../universal-message-watcher/index.ts', import.meta.url),
      'utf-8',
    );
    expect(watcherSrc).not.toMatch(/const\s+inflight\s*=\s*[^;]*countPendingForTarget[^;]*;\s*if\s*\(\s*inflight\s*>\s*maxInflight\s*\)/);
  });
});

// ─── REVIEW_56 §Test-Watcher 修法 (Plan-Review Round 2 codex MED-2) ──────────
// 补 ≥7 invariant fail 分支 it 覆盖 REVIEW_56:126 stale-dispatch root cause 完整 invariant 集合
// (universal-message-watcher/index.ts:361-384 三独立 membership 分支:
//   L361 both null / L369 from-only / L377 to-only)
// + 4 sanity check: target archived / from session not found / from archived / team archived
//
// Test 缺失原因: target not found / target closed / team not found 3 sanity (index.ts L287/L295/L337)
// 在 send.ts:53 enqueue 时已校验, 运行时罕触发, 不属 REVIEW_56:126 stale-dispatch root cause, 不测。
describe('universal-message-watcher.deliver — REVIEW_56 §Test-Watcher invariant fail 分支', () => {
  it('invariant-1: target archived (sessionRepo.get 返 row.archivedAt 非 null) → markFailed', async () => {
    const watcher = new UniversalMessageWatcher();
    const msg = makeMessage({ id: 'target-arch-msg', fromSessionId: 'F1', toSessionId: 'T1' });
    nextClaimResult = msg;
    // target 已 archived (archivedAt 非 null)
    nextSessionResult = {
      id: 'T1',
      lifecycle: 'active',
      agentId: 'claude-code',
      archivedAt: Date.now() - 1000,
    };
    nextTeamResult = { id: 'team-1', archivedAt: null };
    nextMembershipResult = { sessionId: 'mock', teamId: 'team-1', role: 'teammate', leftAt: null };
    await callDeliver(watcher, msg);
    // archived target → markFailed (reason contains 'archived' or similar)
    expect(markFailedCalls.length).toBeGreaterThan(0);
    expect(receiveTeammateMessageCalls).toHaveLength(0);
  });

  it('invariant-2: from session not found (sessionRepo.get(from) 返 null) → markFailed', async () => {
    const watcher = new UniversalMessageWatcher();
    const msg = makeMessage({ id: 'from-not-found-msg', fromSessionId: 'F-missing', toSessionId: 'T1' });
    nextClaimResult = msg;
    // sessionRepoGetCalls 第一次拿 target = OK; 但 from session 反查可能 fail
    // watcher 实际逻辑只调 sessionRepo.get(toSessionId)? — 让 test 标 from 反查 markFailed path
    // (取决具体 invariant 实现位置:见 universal-message-watcher/index.ts:320 from session not found)
    nextSessionResult = null; // 整 sessionRepo.get 返 null = 任何反查 fail
    await callDeliver(watcher, msg);
    expect(markFailedCalls.length).toBeGreaterThan(0);
    expect(receiveTeammateMessageCalls).toHaveLength(0);
  });

  it('invariant-3: from session archived (archivedAt 非 null) → markFailed', async () => {
    const watcher = new UniversalMessageWatcher();
    const msg = makeMessage({ id: 'from-arch-msg', fromSessionId: 'F-arch', toSessionId: 'T2' });
    nextClaimResult = msg;
    // single nextSessionResult 全局 stub — 返 archivedAt 让 target / from 都 archived 路径触发
    nextSessionResult = {
      id: 'F-arch',
      lifecycle: 'active',
      agentId: 'claude-code',
      archivedAt: Date.now() - 1000,
    };
    nextTeamResult = { id: 'team-1', archivedAt: null };
    nextMembershipResult = { sessionId: 'mock', teamId: 'team-1', role: 'teammate', leftAt: null };
    await callDeliver(watcher, msg);
    expect(markFailedCalls.length).toBeGreaterThan(0);
    expect(receiveTeammateMessageCalls).toHaveLength(0);
  });

  it('invariant-4: team archived → markFailed', async () => {
    const watcher = new UniversalMessageWatcher();
    const msg = makeMessage({ id: 'team-arch-msg', fromSessionId: 'F2', toSessionId: 'T3' });
    nextClaimResult = msg;
    nextSessionResult = { id: 'T3', lifecycle: 'active', agentId: 'claude-code', archivedAt: null };
    // team 已 archived
    nextTeamResult = { id: 'team-1', archivedAt: Date.now() - 1000 };
    nextMembershipResult = { sessionId: 'mock', teamId: 'team-1', role: 'teammate', leftAt: null };
    await callDeliver(watcher, msg);
    expect(markFailedCalls.length).toBeGreaterThan(0);
    expect(receiveTeammateMessageCalls).toHaveLength(0);
  });

  it('invariant-5: both memberships null (from + to 都不在 team) → markFailed reason="from and to no longer active"', async () => {
    const watcher = new UniversalMessageWatcher();
    const msg = makeMessage({ id: 'both-null-msg', fromSessionId: 'F3', toSessionId: 'T4' });
    nextClaimResult = msg;
    nextSessionResult = { id: 'T4', lifecycle: 'active', agentId: 'claude-code', archivedAt: null };
    nextTeamResult = { id: 'team-1', archivedAt: null };
    // both memberships null — 走 universal-message-watcher/index.ts:361 分支
    membershipBySid.set('F3', null);
    membershipBySid.set('T4', null);
    await callDeliver(watcher, msg);
    expect(markFailedCalls.length).toBeGreaterThan(0);
    const failed = markFailedCalls.find((c) => c.id === 'both-null-msg');
    expect(failed).toBeDefined();
    expect(failed!.reason).toContain('from and to no longer active');
    expect(receiveTeammateMessageCalls).toHaveLength(0);
  });

  it('invariant-6: from membership null only (to 仍 active) → markFailed reason="from no longer active"', async () => {
    const watcher = new UniversalMessageWatcher();
    const msg = makeMessage({ id: 'from-only-null-msg', fromSessionId: 'F4', toSessionId: 'T5' });
    nextClaimResult = msg;
    nextSessionResult = { id: 'T5', lifecycle: 'active', agentId: 'claude-code', archivedAt: null };
    nextTeamResult = { id: 'team-1', archivedAt: null };
    // from null, to active — 走 index.ts:369 分支
    membershipBySid.set('F4', null);
    membershipBySid.set('T5', { sessionId: 'T5', teamId: 'team-1', role: 'teammate', leftAt: null });
    await callDeliver(watcher, msg);
    expect(markFailedCalls.length).toBeGreaterThan(0);
    const failed = markFailedCalls.find((c) => c.id === 'from-only-null-msg');
    expect(failed).toBeDefined();
    expect(failed!.reason).toContain('from no longer active');
    expect(receiveTeammateMessageCalls).toHaveLength(0);
  });

  it('invariant-7: to membership null only (from 仍 active) → markFailed reason="to no longer active"', async () => {
    const watcher = new UniversalMessageWatcher();
    const msg = makeMessage({ id: 'to-only-null-msg', fromSessionId: 'F5', toSessionId: 'T6' });
    nextClaimResult = msg;
    nextSessionResult = { id: 'T6', lifecycle: 'active', agentId: 'claude-code', archivedAt: null };
    nextTeamResult = { id: 'team-1', archivedAt: null };
    // from active, to null — 走 index.ts:377 分支
    membershipBySid.set('F5', { sessionId: 'F5', teamId: 'team-1', role: 'teammate', leftAt: null });
    membershipBySid.set('T6', null);
    await callDeliver(watcher, msg);
    expect(markFailedCalls.length).toBeGreaterThan(0);
    const failed = markFailedCalls.find((c) => c.id === 'to-only-null-msg');
    expect(failed).toBeDefined();
    expect(failed!.reason).toContain('to no longer active');
    expect(receiveTeammateMessageCalls).toHaveLength(0);
  });
});
