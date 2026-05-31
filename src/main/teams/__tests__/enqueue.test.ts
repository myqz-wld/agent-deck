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

const insertCalls: Array<{ teamId: string; fromSessionId: string; toSessionId: string; body: string }> = [];

vi.mock('@main/store/agent-deck-message-repo', () => ({
  agentDeckMessageRepo: {
    insert: (input: { teamId: string; fromSessionId: string; toSessionId: string; body: string; replyToMessageId?: string | null }) => {
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
