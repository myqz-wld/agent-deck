/**
 * enqueueAgentDeckMessage 单测 — REVIEW_86 LOW (reviewer-claude + reviewer-codex 双方独立):
 * cheap pre-validation 前置到 tryConsume 之前，非法输入（self / 空 / 超长）不烧 rate token。
 *
 * mock agentDeckMessageRepo.insert（track + 透传 real 校验语义）/ eventBus / settingsStore；
 * 用 REAL messageRateLimiter（验 token state）+ REAL MessageInvariantError / MAX_BODY_LENGTH。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentDeckMessage } from '@shared/types';
import { makeEventBusMock } from '@main/__tests__/_shared/mocks/event-bus';
import { makeSettingsStoreMock } from '@main/__tests__/_shared/mocks/settings-store';

const insertCalls: Array<{ teamId: string | null; fromSessionId: string; toSessionId: string; body: string }> = [];

vi.mock('@main/store/agent-deck-message-repo', () => ({
  agentDeckMessageRepo: {
    insert: (input: { teamId: string | null; fromSessionId: string; toSessionId: string; body: string; replyToMessageId?: string | null }) => {
      insertCalls.push({
        teamId: input.teamId,
        fromSessionId: input.fromSessionId,
        toSessionId: input.toSessionId,
        body: input.body,
      });
      const msg: AgentDeckMessage = {
        id: `inserted-${insertCalls.length}`,
        teamId: input.teamId,
        fromSessionId: input.fromSessionId,
        toSessionId: input.toSessionId,
        body: input.body,
        status: 'pending',
        statusReason: null,
        sentAt: Date.now(),
        deliveredAt: null,
        attemptCount: 0,
        lastAttemptAt: null,
        deliveringSince: null,
        replyToMessageId: input.replyToMessageId ?? null,
      };
      return msg;
    },
  },
}));

vi.mock('@main/event-bus', () => ({
  eventBus: makeEventBusMock(),
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: makeSettingsStoreMock({ get: () => 60 }), // mcpMessageRatePerTeamPerMin
}));

// import after mocks
import { enqueueAgentDeckMessage, messageRateLimiter } from '@main/teams/universal-message-watcher';
import { MAX_BODY_LENGTH } from '@main/store/message-delivery-state';

beforeEach(() => {
  insertCalls.length = 0;
  messageRateLimiter.reset();
});

describe('enqueueAgentDeckMessage — REVIEW_86 LOW token-before-insert', () => {
  it('合法输入：insert + 消耗 token，返回 ok', () => {
    const r = enqueueAgentDeckMessage({
      teamId: 'team-1',
      fromSessionId: 'A',
      toSessionId: 'B',
      body: 'hello',
    });
    expect(r.ok).toBe(true);
    expect(insertCalls).toHaveLength(1);
    // 合法输入消耗 1 个 token（bucketCount=1 表示 team-1 桶已建）
    expect(messageRateLimiter.bucketCount).toBe(1);
  });

  it('self-message (from==to) → 抛 MessageInvariantError，不消耗 token（修前 token 已扣）', () => {
    expect(() =>
      enqueueAgentDeckMessage({
        teamId: 'team-self',
        fromSessionId: 'X',
        toSessionId: 'X',
        body: 'self',
      }),
    ).toThrow(/self-message not allowed/);
    // 关键断言：非法输入不入队 + 不烧 token（修前先 tryConsume 再 insert → token 已扣）
    expect(insertCalls).toHaveLength(0);
    expect(messageRateLimiter.bucketCount).toBe(0);
  });

  it('空 body → 抛 MessageInvariantError，不消耗 token', () => {
    expect(() =>
      enqueueAgentDeckMessage({
        teamId: 'team-empty',
        fromSessionId: 'A',
        toSessionId: 'B',
        body: '',
      }),
    ).toThrow(/body 不能为空/);
    expect(insertCalls).toHaveLength(0);
    expect(messageRateLimiter.bucketCount).toBe(0);
  });

  it('body 超长 (> MAX_BODY_LENGTH) → 抛 MessageInvariantError，不消耗 token', () => {
    expect(() =>
      enqueueAgentDeckMessage({
        teamId: 'team-long',
        fromSessionId: 'A',
        toSessionId: 'B',
        body: 'x'.repeat(MAX_BODY_LENGTH + 1),
      }),
    ).toThrow(/超过/);
    expect(insertCalls).toHaveLength(0);
    expect(messageRateLimiter.bucketCount).toBe(0);
  });
});

// plan teamless-dm-20260601 D3：限流桶 key 分流 —— team 走 teamId，teamless 走 `from:<sid>`。
describe('enqueueAgentDeckMessage — teamless rateKey 分流 (D3)', () => {
  it('teamless DM (teamId=null) 用 `from:<fromSessionId>` 桶，不与真实 teamId 桶混淆', () => {
    const r = enqueueAgentDeckMessage({
      teamId: null,
      fromSessionId: 'senderA',
      toSessionId: 'recv1',
      body: 'teamless hi',
    });
    expect(r.ok).toBe(true);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].teamId).toBeNull();
    // 桶建在 `from:senderA`，bucketCount=1
    expect(messageRateLimiter.bucketCount).toBe(1);
  });

  it('两个不同 sender 的 teamless DM 各占独立桶（互不消耗）', () => {
    enqueueAgentDeckMessage({ teamId: null, fromSessionId: 'senderA', toSessionId: 'recv1', body: 'a' });
    enqueueAgentDeckMessage({ teamId: null, fromSessionId: 'senderB', toSessionId: 'recv1', body: 'b' });
    // from:senderA + from:senderB 两个独立桶
    expect(messageRateLimiter.bucketCount).toBe(2);
    expect(insertCalls).toHaveLength(2);
  });

  it('同 sender 跨多 receiver 的 teamless DM 共享单桶（per-sender 成本阀），达 60 后 reject', () => {
    // 同 sender 给不同 receiver 各发，全落 `from:senderA` 单桶
    let lastOk = true;
    let okCount = 0;
    for (let i = 0; i < 61; i++) {
      const r = enqueueAgentDeckMessage({
        teamId: null,
        fromSessionId: 'senderA',
        toSessionId: `recv-${i}`, // 每条不同 receiver
        body: `msg ${i}`,
      });
      if (r.ok) okCount++;
      else lastOk = false;
    }
    // 单桶 60/min：前 60 条 ok，第 61 条 rate-limited
    expect(okCount).toBe(60);
    expect(lastOk).toBe(false);
    // 仍只有 1 个桶（from:senderA），证明跨 receiver 共享
    expect(messageRateLimiter.bucketCount).toBe(1);
  });

  it('teamless `from:<sid>` 桶与同名 teamId 桶不串（前缀隔离）', () => {
    // 极端构造：一个真实 teamId 恰好等于某 sender id（现实中 UUID 不会，但验前缀隔离逻辑）
    enqueueAgentDeckMessage({ teamId: 'collide', fromSessionId: 'sX', toSessionId: 'sY', body: 'team msg' });
    enqueueAgentDeckMessage({ teamId: null, fromSessionId: 'collide', toSessionId: 'sZ', body: 'teamless msg' });
    // 桶 key 分别是 'collide' 和 'from:collide' → 两个独立桶，不串
    expect(messageRateLimiter.bucketCount).toBe(2);
  });
});
