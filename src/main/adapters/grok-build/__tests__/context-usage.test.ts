import { describe, expect, it, vi } from 'vitest';

import type { GrokAcpProcess } from '../acp-process';
import {
  GROK_SESSION_INFO_METHOD,
  parseGrokSessionInfoContext,
  refreshGrokContextUsage,
  scheduleGrokContextUsageRefresh,
} from '../context-usage';
import type { GrokRuntime } from '../runtime-types';
import { createGrokTranslationState } from '../translate';

function makeRuntime(request: ReturnType<typeof vi.fn>): GrokRuntime {
  return {
    applicationSessionId: 'app-session',
    nativeSessionId: 'native-session',
    cwd: '/repo',
    process: {
      connection: { agent: { request, notify: vi.fn() } },
    } as unknown as GrokAcpProcess,
    ready: true,
    queue: [],
    submittingMessage: null,
    running: false,
    interjectionSupported: null,
    sealed: false,
    closed: false,
    disposed: false,
    suppressUpdates: false,
    model: 'grok-4.5',
    runtimeIdentity: { runtimeProvider: 'native', model: 'grok-4.5' },
    thinking: null,
    sessionMode: 'default',
    grokSandbox: null,
    activeGrokSandbox: null,
    restartingSandbox: false,
    agentProfileName: null,
    agentProfileSource: null,
    agentPluginDir: null,
    pendingPermissions: new Map(),
    acceptedEnqueueFingerprints: new Map(),
    translation: createGrokTranslationState(),
  };
}

describe('Grok session context usage', () => {
  it('parses the nested native session/info context and rejects invalid values', () => {
    expect(parseGrokSessionInfoContext({
      result: {
        context: {
          used: 9_658.9,
          total: 500_000.2,
          freeTokens: 490_342,
        },
      },
    })).toEqual({ usedTokens: 9_658, windowTokens: 500_000 });
    expect(parseGrokSessionInfoContext({
      result: { context: { used: -1, total: 500_000 } },
    })).toBeNull();
    expect(parseGrokSessionInfoContext({
      result: { context: { used: 10, total: 0 } },
    })).toBeNull();
  });

  it('requests native context and emits an identity-scoped context snapshot', async () => {
    const request = vi.fn(async () => ({
      result: {
        context: { used: 9_658, total: 500_000, usagePct: 2 },
      },
    }));
    const runtime = makeRuntime(request);
    const emit = vi.fn();

    await expect(refreshGrokContextUsage(runtime, {
      emit,
      isCurrentRuntime: (candidate) => candidate === runtime,
      requestTimeoutMs: 25,
    })).resolves.toBe(true);

    expect(request).toHaveBeenCalledWith(
      GROK_SESSION_INFO_METHOD,
      { sessionId: 'native-session' },
      expect.objectContaining({ cancellationSignal: expect.any(AbortSignal) }),
    );
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'app-session',
      agentId: 'grok-build',
      kind: 'context-usage',
      payload: {
        usedTokens: 9_658,
        windowTokens: 500_000,
        capacitySource: 'runtime-usage',
        runtimeIdentity: { runtimeProvider: 'native', model: 'grok-4.5' },
      },
      source: 'sdk',
    }));
  });

  it('fences a response from a replaced transport', async () => {
    let resolve!: (value: unknown) => void;
    const response = new Promise<unknown>((nextResolve) => {
      resolve = nextResolve;
    });
    const request = vi.fn(() => response);
    const runtime = makeRuntime(request);
    const emit = vi.fn();
    const refresh = refreshGrokContextUsage(runtime, {
      emit,
      requestTimeoutMs: 25,
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    runtime.process = {
      connection: { agent: { request: vi.fn(), notify: vi.fn() } },
    } as unknown as GrokAcpProcess;
    resolve({ result: { context: { used: 20, total: 100 } } });

    await expect(refresh).resolves.toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('serializes queued refreshes so snapshots cannot arrive out of order', async () => {
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise<unknown>((resolve) => {
      resolveFirst = resolve;
    });
    const request = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({
        result: { context: { used: 20, total: 100 } },
      });
    const runtime = makeRuntime(request);
    const emit = vi.fn();
    const options = { emit, requestTimeoutMs: 100 };

    scheduleGrokContextUsageRefresh(runtime, options);
    scheduleGrokContextUsageRefresh(runtime, options);
    expect(request).toHaveBeenCalledOnce();
    resolveFirst({ result: { context: { used: 10, total: 100 } } });

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2));
    expect(emit.mock.calls.map(([event]) => event.payload.usedTokens)).toEqual([10, 20]);
  });
});
