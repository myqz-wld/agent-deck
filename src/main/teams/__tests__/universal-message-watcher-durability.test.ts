import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDeckMessage } from '@shared/types';

interface LeaseLike {
  messageId: string;
  toSessionId: string;
  generation: number;
}

const adapterCalls: Array<{
  toSessionId: string;
  fromSessionId: string;
  body: string;
  messageId: string;
}> = [];
const markDeliveredCalls: string[] = [];
const markFailedCalls: string[] = [];
const retryAfterFailCalls: string[] = [];
let currentMessage: AgentDeckMessage;
let markDeliveredThrows = false;
let markFailedThrows = false;

function makeMessage(status: AgentDeckMessage['status']): AgentDeckMessage {
  return {
    id: 'durability-message',
    teamId: null,
    fromSessionId: 'sender-session',
    toSessionId: 'receiver-session',
    body: 'perform one collaboration action',
    status,
    statusReason: null,
    sentAt: 1,
    deliveredAt: null,
    attemptCount: 0,
    lastAttemptAt: status === 'delivering' ? 100 : null,
    deliveringSince: status === 'delivering' ? 100 : null,
    replyToMessageId: null,
    deliveryGeneration: status === 'delivering' ? 1 : 0,
    deliveryLeaseToSessionId: status === 'delivering' ? 'receiver-session' : null,
  };
}

function cloneCurrent(): AgentDeckMessage {
  return { ...currentMessage };
}

vi.mock('@main/store/agent-deck-message-repo', () => ({
  MAX_RETRY: 3,
  deliveryLeaseOf: (message: AgentDeckMessage): LeaseLike => ({
    messageId: message.id,
    toSessionId: message.toSessionId,
    generation: message.deliveryGeneration,
  }),
  agentDeckMessageRepo: {
    findEligible: () =>
      currentMessage.status === 'pending' ? [cloneCurrent()] : [],
    findEligibleExcludingTargets: () => null,
    countPendingForTarget: () =>
      currentMessage.status === 'pending' || currentMessage.status === 'delivering'
        ? 1
        : 0,
    claim: (messageId: string, now: number) => {
      if (currentMessage.id !== messageId || currentMessage.status !== 'pending') {
        return null;
      }
      currentMessage.status = 'delivering';
      currentMessage.lastAttemptAt = now;
      currentMessage.deliveringSince = now;
      currentMessage.deliveryGeneration += 1;
      currentMessage.deliveryLeaseToSessionId = currentMessage.toSessionId;
      return cloneCurrent();
    },
    markDelivered: (lease: LeaseLike, now: number) => {
      markDeliveredCalls.push(lease.messageId);
      if (markDeliveredThrows) throw new Error('simulated delivered status write failure');
      currentMessage.status = 'delivered';
      currentMessage.deliveredAt = now;
      currentMessage.deliveringSince = null;
      currentMessage.deliveryLeaseToSessionId = null;
      return cloneCurrent();
    },
    markFailed: (lease: LeaseLike, reason: string) => {
      markFailedCalls.push(lease.messageId);
      if (markFailedThrows) throw new Error('simulated failed status write failure');
      currentMessage.status = 'failed';
      currentMessage.statusReason = reason;
      currentMessage.deliveringSince = null;
      currentMessage.deliveryLeaseToSessionId = null;
      return cloneCurrent();
    },
    retryAfterFail: (lease: LeaseLike, reason: string) => {
      retryAfterFailCalls.push(lease.messageId);
      currentMessage.status = 'pending';
      currentMessage.statusReason = reason;
      currentMessage.attemptCount += 1;
      currentMessage.deliveringSince = null;
      currentMessage.deliveryLeaseToSessionId = null;
      return cloneCurrent();
    },
    countDeliveringForSession: (sessionId: string) =>
      currentMessage.status === 'delivering' &&
      (
        currentMessage.fromSessionId === sessionId ||
        currentMessage.toSessionId === sessionId
      )
        ? 1
        : 0,
    countDelivering: () => currentMessage.status === 'delivering' ? 1 : 0,
    terminalizeDeliveringOnStartup: () => {
      if (currentMessage.status !== 'delivering') return 0;
      currentMessage.status = 'failed';
      currentMessage.statusReason =
        '进程重启前的投递结果无法确认；at-most-once 策略已停止重试，以避免重复执行';
      currentMessage.deliveringSince = null;
      currentMessage.deliveryLeaseToSessionId = null;
      return 1;
    },
  },
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: (sessionId: string) => ({
      id: sessionId,
      title: sessionId,
      lifecycle: 'active',
      archivedAt: null,
      agentId: 'claude-code',
    }),
  },
}));

vi.mock('@main/adapters/registry', () => ({
  adapterRegistry: {
    get: () => ({
      capabilities: { canCollaborate: true },
      receiveTeammateMessage: async (
        toSessionId: string,
        fromSessionId: string,
        body: string,
        messageId: string,
      ) => {
        adapterCalls.push({ toSessionId, fromSessionId, body, messageId });
      },
    }),
  },
}));

vi.mock('@main/event-bus', () => ({
  eventBus: {
    on: () => () => {},
    emit: () => {},
  },
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: () => 10 },
}));

vi.mock('@main/store/agent-deck-team-repo', () => ({
  agentDeckTeamRepo: {
    get: () => null,
    list: () => [],
    findActiveMembershipIn: () => null,
  },
}));

import { UniversalMessageWatcher } from '@main/teams/universal-message-watcher';

function callDeliver(
  watcher: UniversalMessageWatcher,
  message: AgentDeckMessage,
): Promise<void> {
  return (
    watcher as unknown as {
      deliver: (candidate: AgentDeckMessage) => Promise<void>;
    }
  ).deliver(message);
}

beforeEach(() => {
  currentMessage = makeMessage('pending');
  markDeliveredThrows = false;
  markFailedThrows = false;
  adapterCalls.length = 0;
  markDeliveredCalls.length = 0;
  markFailedCalls.length = 0;
  retryAfterFailCalls.length = 0;
});

describe('universal-message-watcher post-acceptance durability', () => {
  it('keeps a durable delivering row without retry when both terminal status writes fail', async () => {
    markDeliveredThrows = true;
    markFailedThrows = true;

    await callDeliver(new UniversalMessageWatcher(), cloneCurrent());

    expect(adapterCalls).toHaveLength(1);
    expect(adapterCalls[0]).toMatchObject({
      toSessionId: 'receiver-session',
      fromSessionId: 'sender-session',
      messageId: currentMessage.id,
    });
    expect(markDeliveredCalls).toEqual([currentMessage.id]);
    expect(markFailedCalls).toEqual([currentMessage.id]);
    expect(retryAfterFailCalls).toEqual([]);
    expect(currentMessage).toMatchObject({
      status: 'delivering',
      deliveryLeaseToSessionId: 'receiver-session',
    });
  });

  it('does not report global stop drained while a durable delivering row remains', async () => {
    currentMessage = makeMessage('delivering');

    await expect(new UniversalMessageWatcher().stop({ timeoutMs: 0 })).resolves.toEqual({
      drained: false,
      timedOut: true,
      activeDeliveries: 0,
      durableDelivering: 1,
    });
  });

  it('terminalizes an outcome-unknown row on restart and never injects it again', async () => {
    currentMessage = makeMessage('delivering');
    const restartedWatcher = new UniversalMessageWatcher();
    restartedWatcher.start({ pollIntervalMs: 999_999 });

    try {
      await (
        restartedWatcher as unknown as { process: () => Promise<void> }
      ).process();

      expect(adapterCalls).toEqual([]);
      expect(currentMessage).toMatchObject({
        status: 'failed',
        statusReason: expect.stringContaining('at-most-once'),
        deliveringSince: null,
        deliveryLeaseToSessionId: null,
      });
    } finally {
      await restartedWatcher.stop({ timeoutMs: 0 });
    }
  });
});
