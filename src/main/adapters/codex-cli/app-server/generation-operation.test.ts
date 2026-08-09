import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@main/utils/logger', () => ({
  default: { scope: () => mocks.logger },
}));
import {
  CodexGenerationController,
  type CodexGenerationLifecycleHost,
} from './generation-operation';
import { codexGenerationDiagnostics } from './generation-diagnostics';
import type { CodexAppServerNotification } from './protocol';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('CodexGenerationController', () => {
  it('clears a rejected initialize attempt so the live generation can retry', async () => {
    let attempts = 0;
    const harness = createHarness(async (method) => {
      expect(method).toBe('initialize');
      attempts += 1;
      if (attempts === 1) throw new Error('temporary initialize failure');
      return {};
    });

    await expect(harness.controller.run(
      'initialize',
      undefined,
      (operation) => harness.controller.ensureReady(operation),
    )).rejects.toThrow(/temporary/);
    expect(harness.controller.hasCachedReadiness).toBe(false);

    await expect(harness.controller.run(
      'initialize retry',
      undefined,
      (operation) => harness.controller.ensureReady(operation),
    )).resolves.toBeUndefined();
    expect(harness.controller.hasCachedReadiness).toBe(true);
    expect(harness.controller.generation).toBe(0);
    expect(attempts).toBe(2);
  });

  it('aborts a hung readiness RPC and fences even a generation without an owned child', async () => {
    vi.useFakeTimers();
    const harness = createHarness((_method, _params, signal) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
    }));
    const request = harness.controller.run(
      'thread/start readiness',
      undefined,
      (operation) => operation.request('thread/start', {}),
    );
    const rejection = expect(request).rejects.toThrow(/timed out.*retired/i);

    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;

    expect(harness.controller.generation).toBe(1);
    expect(harness.controller.hasCachedReadiness).toBe(false);
    expect(harness.abortServerRequests).toHaveBeenCalledOnce();
    expect(harness.rejectPending).toHaveBeenCalledOnce();
    expect(harness.notifications).toEqual([
      expect.objectContaining({ method: 'error' }),
    ]);
  });

  it('retires an owned child once and schedules the bounded force-kill fallback', async () => {
    vi.useFakeTimers();
    const kill = vi.fn(() => false);
    const child = {
      kill,
      once: vi.fn(),
      exitCode: null,
      signalCode: null,
    } as unknown as ChildProcessWithoutNullStreams;
    const harness = createHarness(async () => ({}), child);

    expect(harness.controller.recycleControlPlaneGeneration(
      0,
      new Error('unresponsive'),
      'thread/fork readiness',
    )).toBe(true);
    expect(harness.controller.generation).toBe(1);
    expect(harness.getChild()).toBeNull();
    expect(kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(harness.rejectPending).toHaveBeenCalledOnce();
    expect(harness.notifications).toHaveLength(1);
  });

  it('logs expected accepted-turn cancellation below warning severity', () => {
    const harness = createHarness(async () => ({}));

    expect(harness.controller.recycleControlPlaneGeneration(
      0,
      new Error('expected cancellation'),
      'accepted turn cancellation',
    )).toBe(true);

    expect(mocks.logger.info).toHaveBeenCalledWith(
      '[codex-app-server] control-plane generation recycled',
      expect.objectContaining({
        phase: 'accepted_turn_cancellation',
        outcome: 'retired_expected',
      }),
    );
    expect(mocks.logger.warn).not.toHaveBeenCalledWith(
      '[codex-app-server] control-plane generation recycled',
      expect.anything(),
    );
  });

  it('contains diagnostic failures without changing a successful operation', async () => {
    const harness = createHarness(async () => ({}), null, {
      ...codexGenerationDiagnostics,
      threadBoundaryReady: () => {
        throw new Error('diagnostic failure');
      },
    });

    await expect(harness.controller.run(
      'thread/start readiness',
      undefined,
      (operation) => operation.request('thread/start', {}),
    )).resolves.toEqual({});
  });
});

function createHarness(
  requestRawImpl: (
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown>,
  initialChild: ChildProcessWithoutNullStreams | null = null,
  diagnostics = codexGenerationDiagnostics,
) {
  let child = initialChild;
  const notifications: CodexAppServerNotification[] = [];
  const abortServerRequests = vi.fn();
  const rejectPending = vi.fn();
  let controller: CodexGenerationController;
  const host: CodexGenerationLifecycleHost = {
    isClosed: () => false,
    getChild: () => child,
    detachChild: (candidate) => {
      if (candidate !== child) return false;
      child = null;
      return true;
    },
    requestRaw: <T>(method: string, params: unknown, signal?: AbortSignal) =>
      requestRawImpl(method, params, signal) as Promise<T>,
    requestForOperation: <T>(method: string, params: unknown, operation) =>
      controller.request<T>(method, params, operation),
    getSkillExtraRoots: () => undefined,
    abortServerRequests,
    rejectPending,
    dispatchNotification: (notification) => notifications.push(notification),
  };
  controller = new CodexGenerationController(host, diagnostics);
  return {
    controller,
    notifications,
    abortServerRequests,
    rejectPending,
    getChild: () => child,
  };
}
