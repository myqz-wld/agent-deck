import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrokPermissionController } from '../permission-controller';
import type { GrokRuntime } from '../runtime-types';
import { createGrokTranslationState } from '../translate';
import { GrokRuntimeLifecycleCoordinator } from '../runtime-lifecycle-coordinator';
import { sessionManager } from '@main/session/manager';
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import { TrustedContinuationAcceptanceController } from '@main/adapters/trusted-continuation';

vi.mock('@main/session/manager', () => ({
  sessionManager: { releaseSdkClaim: vi.fn() },
}));
vi.mock('@main/agent-deck-mcp/mcp-session-token-map', () => ({
  release: vi.fn(),
}));

function runtime(stop: () => Promise<void>): GrokRuntime {
  return {
    applicationSessionId: 'child',
    nativeSessionId: 'native-child',
    cwd: '/repo',
    process: {
      stop: vi.fn(stop),
    } as unknown as GrokRuntime['process'],
    ready: true,
    queue: [],
    submittingMessage: null,
    running: false,
    interjectionSupported: null,
    sealed: false,
    closed: false,
    disposed: false,
    suppressUpdates: false,
    model: 'grok',
    runtimeIdentity: { runtimeProvider: 'native', model: 'grok-4.5' },
    thinking: null,
    sessionMode: null,
    grokSandbox: null,
    restartingSandbox: false,
    agentProfileName: null,
    agentProfileSource: null,
    agentPluginDir: null,
    pendingPermissions: new Map(),
    acceptedEnqueueFingerprints: new Map(),
    translation: createGrokTranslationState({}),
  };
}

function harness(stop: () => Promise<void> = async () => undefined) {
  const target = runtime(stop);
  const runtimes = new Map([['child', target]]);
  const permissionController = { cancel: vi.fn() } as unknown as GrokPermissionController;
  const cancelSubmittingInterjection = vi.fn();
  const coordinator = new GrokRuntimeLifecycleCoordinator(
    runtimes,
    permissionController,
    cancelSubmittingInterjection,
    sessionManager,
  );
  return { target, runtimes, permissionController, coordinator };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Grok runtime lifecycle coordinator', () => {
  it('cancels both the provider session and the pending prompt request', async () => {
    const h = harness();
    const notify = vi.fn(async () => undefined);
    const abort = vi.fn();
    h.target.running = true;
    h.target.currentTurnController = { abort } as unknown as AbortController;
    h.target.process = {
      ...h.target.process,
      connection: { agent: { notify } },
    } as unknown as GrokRuntime['process'];

    await h.coordinator.interrupt('child');

    expect(notify).toHaveBeenCalledWith('session/cancel', {
      sessionId: 'native-child',
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(h.target.interruptRequested).toBe(true);
    expect(h.permissionController.cancel).toHaveBeenCalledWith(h.target);
  });

  it('strictly stops the provider before releasing runtime ownership', async () => {
    const h = harness();
    const stop = vi.mocked(h.target.process!.stop);

    await h.coordinator.closeForRollback('child');

    expect(stop).toHaveBeenCalledTimes(1);
    expect(h.runtimes.size).toBe(0);
    expect(h.target.process).toBeNull();
    expect(h.target.disposed).toBe(true);
    expect(h.target.runtimeIdentity).toBeNull();
    expect(mcpSessionTokenMap.release).toHaveBeenCalledWith('child');
    expect(sessionManager.releaseSdkClaim).toHaveBeenCalledWith('child');
  });

  it('rejects unsettled trusted readiness when rollback closes the runtime', async () => {
    const h = harness();
    const acceptance = new TrustedContinuationAcceptanceController();
    h.target.trustedContinuationAcceptance = acceptance;

    await h.coordinator.closeForRollback('child');

    await expect(acceptance.acceptance).resolves.toEqual({
      status: 'rejected', reason: 'provider-error',
    });
    expect(h.target.trustedContinuationAcceptance).toBeUndefined();
  });

  it('rejects stop failure while retaining the process and runtime for retry', async () => {
    const h = harness(async () => {
      throw new Error('stop failed');
    });
    const process = h.target.process;

    await expect(h.coordinator.closeForRollback('child')).rejects.toThrow('stop failed');

    expect(h.runtimes.get('child')).toBe(h.target);
    expect(h.target.process).toBe(process);
    expect(h.target.disposed).toBe(false);
    expect(mcpSessionTokenMap.release).not.toHaveBeenCalled();
    expect(sessionManager.releaseSdkClaim).not.toHaveBeenCalled();
  });

  it('preserves ordinary close ordering and releases ownership before stop failure', async () => {
    const h = harness(async () => {
      throw new Error('stop failed');
    });

    await expect(h.coordinator.closeOrdinary('child')).rejects.toThrow('stop failed');

    expect(h.runtimes.size).toBe(0);
    expect(h.target.process).toBeNull();
    expect(h.target.disposed).toBe(true);
    expect(mcpSessionTokenMap.release).toHaveBeenCalledWith('child');
  });

  it('rejects a missing strict target instead of silently releasing a database id', async () => {
    const h = harness();
    h.runtimes.clear();

    await expect(h.coordinator.closeForRollback('child')).rejects.toThrow(
      /cannot prove a live target runtime/,
    );
  });
});
