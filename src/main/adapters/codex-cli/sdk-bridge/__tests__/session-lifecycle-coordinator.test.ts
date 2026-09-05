import { CodexPendingTurnQueue } from '@main/adapters/codex-cli/sdk-bridge/pending-turn-queue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexAppServerClient } from '../../app-server/client';
import { CodexSessionLifecycleCoordinator } from '../session-lifecycle-coordinator';
import type { InternalSession } from '../types';
import { codexBridgeTestRuntimeHost } from './runtime-host-fixture';

function internal(): InternalSession {
  return {
    applicationSid: 'child',
    threadId: 'native-child',
    currentTurn: null,
    currentTurnId: null,
    turnLoopRunning: false,
    intentionallyClosed: false,
    pendingTurns: new CodexPendingTurnQueue(),
    pendingPermissions: new Map(),
    acceptedEnqueueFingerprints: new Map(),
    submittingUserMessage: null,
  } as unknown as InternalSession;
}

function harness(dispose: () => void = () => undefined) {
  const session = internal();
  const client = {
    dispose: vi.fn(dispose),
    isProcessAlive: true,
  } as unknown as CodexAppServerClient;
  const sessions = new Map<string, InternalSession>([
    ['child', session],
    ['native-child', session],
  ]);
  const clients = new Map<string, CodexAppServerClient>([
    ['child', client],
    ['native-child', client],
  ]);
  const cancelPermission = vi.fn();
  const releaseClaim = vi.fn();
  const releaseToken = vi.fn();
  const coordinator = new CodexSessionLifecycleCoordinator(
    sessions,
    clients,
    cancelPermission,
    {
      sessions,
      clients,
      releaseClaim,
      releaseToken,
      runtimeHost: codexBridgeTestRuntimeHost,
    },
  );
  return {
    session,
    client,
    sessions,
    clients,
    cancelPermission,
    releaseClaim,
    releaseToken,
    coordinator,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Codex session lifecycle coordinator', () => {
  it('strictly disposes the provider and releases every runtime identity', async () => {
    const h = harness();

    await h.coordinator.closeForRollback('child');

    expect(h.client.dispose).toHaveBeenCalledTimes(1);
    expect(h.sessions.size).toBe(0);
    expect(h.clients.size).toBe(0);
    expect(h.releaseClaim).toHaveBeenCalledWith('child');
    expect(h.releaseClaim).toHaveBeenCalledWith('native-child');
    expect(h.releaseToken).toHaveBeenCalledWith('child');
    expect(h.session.retirementFinalized).toBe(true);
  });

  it('rejects dispose failure and preserves runtime ownership for retry', async () => {
    const h = harness(() => {
      throw new Error('dispose failed');
    });

    await expect(h.coordinator.closeForRollback('child')).rejects.toThrow(
      /client-dispose/,
    );

    expect(h.sessions.get('child')).toBe(h.session);
    expect(h.clients.get('child')).toBe(h.client);
    expect(h.session.retirementFinalized).not.toBe(true);
  });

  it('rejects claim or token residuals after provider disposal', async () => {
    const h = harness();
    h.releaseClaim.mockImplementationOnce(() => {
      throw new Error('claim failed');
    });
    h.releaseToken.mockImplementationOnce(() => {
      throw new Error('token failed');
    });

    await expect(h.coordinator.closeForRollback('child')).rejects.toThrow(
      /claim-release, token-release/,
    );
    expect(h.sessions.get('child')).toBe(h.session);
    expect(h.clients.get('child')).toBe(h.client);
  });

  it('preserves ordinary best-effort retirement when client disposal throws', async () => {
    const h = harness(() => {
      throw new Error('dispose failed');
    });

    await expect(h.coordinator.closeOrdinary('child')).resolves.toBeUndefined();

    expect(h.sessions.size).toBe(0);
    expect(h.clients.size).toBe(0);
    expect(h.releaseClaim).toHaveBeenCalled();
    expect(h.releaseToken).toHaveBeenCalled();
  });

  it('validates live fork ownership through the same runtime identity map', () => {
    const h = harness();

    expect(() => h.coordinator.validateForkSource({
      applicationSessionId: 'child',
      nativeSessionId: 'native-child',
      cwd: '/repo',
    })).not.toThrow();
    expect(() => h.coordinator.validateForkSource({
      applicationSessionId: 'child',
      nativeSessionId: 'other-native',
      cwd: '/repo',
    })).toThrow(/caller-owned live app-server state/);
  });
});
