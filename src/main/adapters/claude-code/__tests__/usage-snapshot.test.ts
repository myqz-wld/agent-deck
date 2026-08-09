import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSdkBridge } from '../sdk-bridge';
import { desktopClaudeSessionDefaultsHost } from '../sdk-bridge/session-defaults-host';
import { desktopClaudeRestartSessionHost } from '../sdk-bridge/restart-session-host';
import { desktopClaudeRecoveryFreshnessHost } from '../sdk-bridge/recovery-freshness-host';
import { desktopSessionModelControllerHost } from '@main/adapters/session-model-controller-host';
import { desktopClaudeJsonlDiscoveryHost } from '../sdk-bridge/recoverer/jsonl-discovery-host';
import { desktopClaudePermissionResponderHost } from '../sdk-bridge/permission-responder-host';
import { desktopClaudeCwdTransitionHost } from '../sdk-bridge/cwd-transition-controller-host';
import { desktopClaudeMessageControllerHost } from '../sdk-bridge/message-controller-host';
import { createDesktopClaudeSessionLifecycleHost } from '../sdk-bridge/session-lifecycle-host';
import { desktopClaudePendingOutgoingHost } from '../sdk-bridge/pending-outgoing-host';
import { createDesktopClaudeStreamProcessorHost } from '../sdk-bridge/stream-processor-host';
import { createDesktopClaudeSessionFinalizeHost } from '../sdk-bridge/session-finalize-host';
import { desktopClaudeCanUseToolHost } from '../sdk-bridge/can-use-tool-host';
import { desktopClaudeCreateSessionSdkQueryHost } from '../sdk-bridge/create-session/create-session-sdk-query-host';
import type { ClaudeUsageSnapshotHost } from '../usage-snapshot-core';

const mocks = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@main/utils/logger', () => ({
  default: {
    ...mocks.logger,
    scope: () => mocks.logger,
  },
}));

function usagePayload(fiveHour = 0, sevenDay = 0) {
  return {
    session: {
      total_cost_usd: 0,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: {},
    },
    subscription_type: 'pro',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: fiveHour, resets_at: null },
      seven_day: { utilization: sevenDay, resets_at: null },
    },
    behaviors: null,
  };
}

const backgroundUsage = vi.fn();
const loadSdk = vi.fn(async () => ({
  query: (input: Parameters<Awaited<ReturnType<ClaudeUsageSnapshotHost['loadSdk']>>['query']>[0]) => ({
    close: vi.fn(),
    initializationResult: vi.fn(async () => undefined),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: backgroundUsage,
    async *[Symbol.asyncIterator]() {
      const signal = input.options.abortController.signal;
      if (!signal.aborted) {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), {
          once: true,
        }));
      }
    },
  }),
}));

const usageSnapshotHost: ClaudeUsageSnapshotHost = {
  loadSdk,
  getRuntimeOptions: () => ({ executable: 'node', env: {} }),
  resolveClaudeBinary: () => undefined,
  getProbeCwd: () => '/usage-probe',
  expectSdkSession: () => vi.fn(),
  now: () => 123,
};

function makeBridge(): ClaudeSdkBridge {
  const sessionManager = {
    claimAsSdk: vi.fn(),
    releaseSdkClaim: vi.fn(),
    markRecentlyDeleted: vi.fn(),
    expectSdkSession: vi.fn(() => () => undefined),
    delete: vi.fn(async () => undefined),
    getCloseEpoch: vi.fn(() => 0),
    markClosed: vi.fn(),
    unarchive: vi.fn(async () => undefined),
    renameSdkSession: vi.fn(),
    updateCliSessionId: vi.fn(),
  };
  return new ClaudeSdkBridge({
    createSessionHost: desktopClaudeSessionDefaultsHost,
    jsonlDiscoveryHost: desktopClaudeJsonlDiscoveryHost,
    recoveryFreshnessHost: desktopClaudeRecoveryFreshnessHost,
    restartSessionHost: desktopClaudeRestartSessionHost,
    sessionModelHost: desktopSessionModelControllerHost,
    usageSnapshotHost,
    permissionResponderHost: desktopClaudePermissionResponderHost,
    cwdTransitionHost: desktopClaudeCwdTransitionHost,
    messageControllerHost: desktopClaudeMessageControllerHost,
    sessionLifecycleHost: createDesktopClaudeSessionLifecycleHost(sessionManager),
    pendingOutgoingHost: desktopClaudePendingOutgoingHost,
    streamProcessorHost: createDesktopClaudeStreamProcessorHost(sessionManager),
    sessionFinalizeHost: createDesktopClaudeSessionFinalizeHost(sessionManager),
    canUseToolHost: desktopClaudeCanUseToolHost,
    createSessionSdkQueryHost: desktopClaudeCreateSessionSdkQueryHost,
    emit: vi.fn(),
    sessionManager,
  });
}

function setClaudeSessions(bridge: ClaudeSdkBridge, sessions: unknown[]): void {
  (bridge as unknown as { sessions: Map<string, unknown> }).sessions = new Map(
    sessions.map((session, index) => [`sid-${index}`, session]),
  );
}

describe('ClaudeSdkBridge getUsageSnapshot', () => {
  beforeEach(() => {
    loadSdk.mockClear();
    backgroundUsage.mockReset().mockResolvedValue(usagePayload());
    for (const method of Object.values(mocks.logger)) method.mockReset();
  });

  it('uses the background usage probe when no live query exists', async () => {
    const snapshot = await makeBridge().getUsageSnapshot();

    expect(snapshot).toMatchObject({
      provider: 'claude-code',
      label: 'Claude Code',
      status: 'ok',
    });
    expect(loadSdk).toHaveBeenCalledTimes(1);
  });

  it('skips sessions that are already closing and uses the probe', async () => {
    const bridge = makeBridge();
    const usage = vi.fn();
    setClaudeSessions(bridge, [
      {
        expectedClose: true,
        query: {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage,
        },
      },
    ]);

    const snapshot = await bridge.getUsageSnapshot();

    expect(usage).not.toHaveBeenCalled();
    expect(snapshot.status).toBe('ok');
    expect(loadSdk).toHaveBeenCalledTimes(1);
  });

  it('reads usage through an already live SDK query', async () => {
    const bridge = makeBridge();
    const usage = vi.fn().mockResolvedValue(usagePayload(22, 44));
    setClaudeSessions(bridge, [
      {
        expectedClose: false,
        query: {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage,
        },
      },
    ]);

    const snapshot = await bridge.getUsageSnapshot();

    expect(usage).toHaveBeenCalledTimes(1);
    expect(snapshot).toMatchObject({
      provider: 'claude-code',
      label: 'Claude Code',
      status: 'ok',
    });
    expect(snapshot.windows.map((w) => w.usedPercent)).toEqual([22, 44]);
    expect(loadSdk).not.toHaveBeenCalled();
  });

  it('returns a generic error snapshot without adapter-local raw logging', async () => {
    const bridge = makeBridge();
    const usage = vi.fn().mockRejectedValue(
      new Error('Bearer private-token /Users/private/repo raw provider response'),
    );
    setClaudeSessions(bridge, [
      {
        expectedClose: false,
        query: {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage,
        },
      },
    ]);

    const snapshot = await bridge.getUsageSnapshot();

    expect(snapshot).toMatchObject({
      provider: 'claude-code',
      label: 'Claude Code',
      status: 'error',
      message: '额度信息读取失败，请稍后重试',
    });
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.debug).not.toHaveBeenCalled();
    expect(JSON.stringify(snapshot)).not.toContain('private-token');
    expect(JSON.stringify(snapshot)).not.toContain('/Users/private/repo');
  });
});
