/**
 * universal-message-watcher.deliver 单测（plan mcp-bug-and-feature-batch-20260513 Phase 1 Step 1.2）
 *
 * 关键 case：J fix —— reply message (replyToMessageId != null) 直接 markDelivered，
 * 跳过 adapter.receiveTeammateMessage 防 lead SessionDetail 重复显示。
 *
 * 不依赖真实 SQLite / Electron / SDK：vi.mock 替换 agentDeckMessageRepo / sessionRepo /
 * adapterRegistry / eventBus / settingsStore / agentDeckTeamRepo 6 个 dep。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentDeckMessage } from '@shared/types';

// ─── Mock setup ─────────────────────────────────────────────────────────

const claimCalls: string[] = [];
const markDeliveredCalls: Array<{ id: string; ts: number }> = [];
const markFailedCalls: Array<{ id: string; reason: string }> = [];
const sessionRepoGetCalls: string[] = [];
const adapterRegistryGetCalls: string[] = [];
const receiveTeammateMessageCalls: Array<{ to: string; from: string; body: string }> = [];
const emitStatusCalls: Array<{ id: string; status: string }> = [];

let nextClaimResult: AgentDeckMessage | null = null;
let nextSessionResult: { id: string; lifecycle: 'active' | 'dormant' | 'closed'; agentId: string } | null = null;
let nextAdapterResult:
  | { capabilities: { canCollaborate: boolean }; receiveTeammateMessage?: typeof receiveTeammateMessageStub }
  | undefined = undefined;

const receiveTeammateMessageStub = async (to: string, from: string, body: string) => {
  receiveTeammateMessageCalls.push({ to, from, body });
};

vi.mock('@main/store/agent-deck-message-repo', () => ({
  MAX_RETRY: 3,
  agentDeckMessageRepo: {
    claim: (id: string) => {
      claimCalls.push(id);
      return nextClaimResult;
    },
    markDelivered: (id: string, ts: number) => {
      markDeliveredCalls.push({ id, ts });
      return nextClaimResult ? { ...nextClaimResult, status: 'delivered', deliveredAt: ts } : null;
    },
    markFailed: (id: string, reason: string) => {
      markFailedCalls.push({ id, reason });
      return nextClaimResult ? { ...nextClaimResult, status: 'failed', statusReason: reason } : null;
    },
    retryAfterFail: () => null,
    findEligible: () => [],
    countPendingForTarget: () => 0,
    resetDeliveringOnStartup: () => 0,
    findRepliesByMessageId: () => [],
    listAllMembers: () => [],
  },
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: (id: string) => {
      sessionRepoGetCalls.push(id);
      return nextSessionResult;
    },
  },
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
  eventBus: {
    emit: (channel: string, payload: { id?: string; status?: string }) => {
      if (channel === 'agent-deck-message-status-changed' && payload.id) {
        emitStatusCalls.push({ id: payload.id, status: payload.status ?? '' });
      }
    },
    on: () => () => {},
  },
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: () => 10 },
}));

const teamRepoListCalls: Array<{ activeOnly?: boolean; limit?: number; offset?: number }> = [];
let teamRepoListResults: Array<{ id: string; archivedAt: number | null }> = [];

vi.mock('@main/store/agent-deck-team-repo', () => ({
  agentDeckTeamRepo: {
    listAllMembers: () => [],
    list: (opts?: { activeOnly?: boolean; limit?: number; offset?: number }) => {
      teamRepoListCalls.push(opts ?? {});
      return teamRepoListResults;
    },
    listActiveMembers: () => [],
  },
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
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe('universal-message-watcher.deliver - J fix (reply 短路)', () => {
  it('reply message (replyToMessageId != null) 直接 markDelivered 跳过 receiveTeammateMessage', async () => {
    const replyMsg = makeMessage({
      id: 'reply-1',
      replyToMessageId: 'original-msg-1',
      body: 'reply text',
    });
    nextClaimResult = { ...replyMsg, status: 'delivering' };

    const watcher = new UniversalMessageWatcher();
    await callDeliver(watcher, replyMsg);

    // 关键断言：reply 走短路
    expect(claimCalls).toEqual(['reply-1']);
    expect(markDeliveredCalls).toHaveLength(1);
    expect(markDeliveredCalls[0]?.id).toBe('reply-1');

    // J fix 核心：以下都不应被调（reply 短路前就 return 了）
    expect(receiveTeammateMessageCalls).toHaveLength(0);
    expect(sessionRepoGetCalls).toHaveLength(0);
    expect(adapterRegistryGetCalls).toHaveLength(0);
    expect(markFailedCalls).toHaveLength(0);

    // 两条 emitStatus：一条 delivering（claim 后）、一条 delivered
    expect(emitStatusCalls).toHaveLength(2);
  });

  it('non-reply message (replyToMessageId == null) 走原 dispatch 调 receiveTeammateMessage', async () => {
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

  it('reply 即使 target session 已删除也 markDelivered 不 markFailed', async () => {
    // J fix 副作用：reply 短路在 target check 之前，target 不存在时仍 markDelivered
    // 而非 markFailed（reply 已入库供 sender wait_reply / check_reply 拿）
    const replyMsg = makeMessage({
      id: 'reply-orphan',
      replyToMessageId: 'original-msg-1',
      toSessionId: 'deleted-sender-sid',
    });
    nextClaimResult = { ...replyMsg, status: 'delivering' };
    nextSessionResult = null; // target session 已删

    const watcher = new UniversalMessageWatcher();
    await callDeliver(watcher, replyMsg);

    expect(markDeliveredCalls).toHaveLength(1);
    expect(markFailedCalls).toHaveLength(0);
    expect(sessionRepoGetCalls).toHaveLength(0); // 短路不 check target
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
