import { describe, expect, it, vi } from 'vitest';

import {
  issueRemoteOwnerGrantClaim,
  type AuthenticatedClientAccessContext,
  type CoreMethod,
  type JsonObject,
} from '@contracts/index';
import type { DaemonCoreRuntime, DaemonRequestInput } from '@hosts/daemon';
import type { AgentAdapter } from '@main/adapters/types';
import { ServerCoreUsageRuntime } from './usage-runtime';

const desktop: AuthenticatedClientAccessContext = {
  kind: 'authenticated-client', topology: 'full', instanceId: 'instance-a',
  clientId: 'desktop-a', transport: 'ssh', connectionScope: 'credential-a',
  authority: 'owner-equivalent', surface: 'desktop',
  grant: issueRemoteOwnerGrantClaim('desktop'),
};

function request(
  method: CoreMethod,
  params: JsonObject,
  access: AuthenticatedClientAccessContext = desktop,
): DaemonRequestInput {
  return {
    access, requestId: `request-${method}`, method, params, idempotencyKey: null,
    expectedRevision: null, deadlineAt: null, signal: new AbortController().signal,
  };
}

function harness(getUsageSnapshotOverride?: AgentAdapter['getUsageSnapshot']) {
  const base: DaemonCoreRuntime = {
    supportedMethods: ['system.health'],
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    currentRevision: () => 9,
    execute: vi.fn(async () => ({ result: { ok: true, revision: 9 }, revision: 9 })),
  };
  const defaultUsageSnapshot: NonNullable<AgentAdapter['getUsageSnapshot']> = async () => ({
    provider: 'codex-cli' as const,
    label: 'Codex',
    status: 'ok' as const,
    windows: [{
      id: 'current' as const,
      label: '5 小时',
      usedPercent: 20,
      resetsAt: '2026-08-10T12:00:00.000Z',
    }],
    updatedAt: 10,
  });
  const getUsageSnapshot = vi.fn(getUsageSnapshotOverride ?? defaultUsageSnapshot);
  const codex = { getUsageSnapshot } as unknown as AgentAdapter;
  const runtime = new ServerCoreUsageRuntime(base, {
    tokenUsage: {
      ratesSince: () => [{ bucketKey: 'gpt-5.6-sol', outputTokens: 60 }],
      today: () => [{ bucketKey: 'gpt-5.6-sol', outputTokens: 600 }],
      dailyByModel: () => [{
        bucketKey: 'gpt-5.6-sol', day: '2026-08-10',
        providerTotalTokens: 20, providerTotalApplicable: true,
        inputTotalTokens: 12, inputTotalApplicable: true,
        outputTokens: 8, outputApplicable: true,
        reasoningTokens: 2, reasoningApplicable: true,
        cacheReadTokens: null, cacheReadApplicable: false,
        cacheCreationTokens: null, cacheCreationApplicable: false,
      }],
    },
    registry: { get: (id) => id === 'codex-cli' ? codex : undefined },
    currentRevision: () => 9,
  });
  return { base, getUsageSnapshot, runtime };
}

describe('ServerCoreUsageRuntime', () => {
  it('returns the exact bounded token ledger without exposing Worker paths', async () => {
    const { runtime } = harness();
    expect(runtime.supportedMethods).toContain('usage.tokens.get');
    await expect(runtime.execute(request('usage.tokens.get', {
      includeDaily: true, dailyLimit: 100,
    }))).resolves.toMatchObject({
      result: {
        rates: [{ bucketKey: 'gpt-5.6-sol', outputTokens: 60 }],
        topToday: [{ bucketKey: 'gpt-5.6-sol', outputTokens: 600 }],
        daily: [{ day: '2026-08-10', inputTotalTokens: 12 }],
        dailyTruncated: false,
        today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        revision: 9,
      },
    });
  });

  it('caches provider quota reads and refreshes only when forced', async () => {
    const { getUsageSnapshot, runtime } = harness();
    const cached = request('usage.providers.get', { force: false });
    await runtime.execute(cached);
    await runtime.execute({ ...cached, requestId: 'request-cached' });
    expect(getUsageSnapshot).toHaveBeenCalledOnce();
    await runtime.execute(request('usage.providers.get', { force: true }));
    expect(getUsageSnapshot).toHaveBeenCalledTimes(2);
  });

  it('does not pre-empt a healthy cold provider probe at the former five-second fence', async () => {
    vi.useFakeTimers();
    try {
      const { runtime } = harness(() => new Promise((resolve) => {
        setTimeout(() => resolve({
          provider: 'codex-cli',
          label: 'Codex',
          status: 'ok',
          windows: [],
          updatedAt: 10,
        }), 6_000);
      }));
      const pending = runtime.execute(request('usage.providers.get', { force: true }));
      await vi.advanceTimersByTimeAsync(6_000);
      await expect(pending).resolves.toMatchObject({
        result: {
          snapshots: expect.arrayContaining([
            expect.objectContaining({ provider: 'codex-cli', status: 'ok' }),
          ]),
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects invalid requests and grants Feishu the same usage reads', async () => {
    const { runtime } = harness();
    await expect(runtime.execute(request('usage.tokens.get', {
      includeDaily: true, dailyLimit: 0,
    }))).rejects.toMatchObject({ code: 'invalid_request' });
    const feishu = {
      ...desktop, clientId: 'feishu-a', transport: 'feishu' as const,
      surface: 'feishu' as const,
      grant: issueRemoteOwnerGrantClaim('feishu'),
    };
    await expect(runtime.execute(request(
      'usage.providers.get',
      { force: false },
      feishu,
    ))).resolves.toMatchObject({ result: { snapshots: expect.any(Array) } });
  });
});
