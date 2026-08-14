// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteHostRuntimeControlsDto } from '@shared/remote-host';

import { RemoteUserIntentLedger } from './remote-intent-ledger';
import { createRemoteSessionActions } from './remote-session-actions';

describe('Remote session mutation authority', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, 'api');
  });

  it('dispatches no mutation when the source generation changes during attachment hashing', async () => {
    let resolveDigest!: (value: ArrayBuffer) => void;
    const digest = new Promise<ArrayBuffer>((resolve) => { resolveDigest = resolve; });
    const digestSpy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockReturnValue(digest);
    const sendRemoteHostMessage = vi.fn(async () => ({
      messageId: 'message-a', sequence: 1, revision: 2,
    }));
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { sendRemoteHostMessage },
    });

    const identityRef = { current: 'profile-a|core-a|1' };
    const actions = createRemoteSessionActions({
      activeProfileId: 'profile-a',
      expectedAuthority: { authoritativeCoreId: 'core-a', workerGeneration: 1 },
      identityRef,
      intents: new RemoteUserIntentLedger(() => 'intent-a'),
      requireCapability: vi.fn(),
      runBusiness: (operation) => operation(),
      runTerminalBusiness: (operation) => operation(),
      runtimeRef: { current: null as RemoteHostRuntimeControlsDto | null },
      selectSession: vi.fn(),
      setRuntime: vi.fn(),
      sourceIdentity: identityRef.current,
      target: () => ({ profileId: 'profile-a', sessionId: 'session-a' }),
    });

    const pending = actions.send('with image', [{
      kind: 'image', base64: 'YQ==', mime: 'image/png', bytes: 1,
    }]);
    await vi.waitFor(() => expect(digestSpy).toHaveBeenCalledOnce());
    identityRef.current = 'profile-a|core-a|2';
    resolveDigest(new Uint8Array(32).buffer);

    await expect(pending).rejects.toThrow('数据源已切换');
    expect(sendRemoteHostMessage).not.toHaveBeenCalled();
  });

  it('binds history and Workspace mutations to the current Core generation', async () => {
    const archiveRemoteHostSession = vi.fn(async () => ({
      sessionId: 'session-a', state: 'archived' as const, revision: 3,
    }));
    const createRemoteHostWorkspaceDirectory = vi.fn(async () => ({
      directory: 'repo/new-folder', revision: 4,
    }));
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { archiveRemoteHostSession, createRemoteHostWorkspaceDirectory },
    });
    const identityRef = { current: 'profile-a|core-a|1' };
    const actions = createRemoteSessionActions({
      activeProfileId: 'profile-a',
      expectedAuthority: { authoritativeCoreId: 'core-a', workerGeneration: 1 },
      identityRef,
      intents: new RemoteUserIntentLedger(() => 'intent-a'),
      requireCapability: vi.fn(),
      runBusiness: (operation) => operation(),
      runTerminalBusiness: (operation) => operation(),
      runtimeRef: { current: null as RemoteHostRuntimeControlsDto | null },
      selectSession: vi.fn(),
      setRuntime: vi.fn(),
      sourceIdentity: identityRef.current,
      target: () => ({ profileId: 'profile-a', sessionId: 'session-a' }),
    });

    await actions.archiveHistorySession({
      id: 'session-a', adapterId: 'codex-cli', title: 'History', source: 'sdk',
      lifecycle: 'closed', activity: 'finished', archived: false, pinned: false,
      createdAt: 1, updatedAt: 2, endedAt: 2, model: null, thinking: null,
      runtimeProvider: null, context: null, spawnedBy: null, spawnDepth: 0,
      teams: [], summary: null, summaryGenerationSource: null, workspaceLabel: 'Workspace',
      contextOnly: false,
    });
    await expect(actions.createWorkspaceDirectory('repo', 'new-folder'))
      .resolves.toBe('repo/new-folder');
    expect(archiveRemoteHostSession).toHaveBeenCalledWith(expect.objectContaining({
      expectedAuthority: { authoritativeCoreId: 'core-a', workerGeneration: 1 },
      expectedArchived: false,
      expectedUpdatedAt: 2,
    }));
    expect(createRemoteHostWorkspaceDirectory).toHaveBeenCalledWith(expect.objectContaining({
      expectedAuthority: { authoritativeCoreId: 'core-a', workerGeneration: 1 },
      parentDirectory: 'repo',
      name: 'new-folder',
    }));
  });

  it('binds dormant reactivation to its dedicated capability and intent', async () => {
    const reactivateRemoteHostSession = vi.fn(async () => ({
      sessionId: 'session-a', state: 'reactivated' as const, revision: 3,
    }));
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { reactivateRemoteHostSession },
    });
    const requireCapability = vi.fn();
    const identityRef = { current: 'profile-a|core-a|1' };
    const actions = createRemoteSessionActions({
      activeProfileId: 'profile-a',
      expectedAuthority: { authoritativeCoreId: 'core-a', workerGeneration: 1 },
      identityRef,
      intents: new RemoteUserIntentLedger(() => 'intent-r'),
      requireCapability,
      runBusiness: (operation) => operation(),
      runTerminalBusiness: (operation) => operation(),
      runtimeRef: { current: null },
      selectSession: vi.fn(),
      setRuntime: vi.fn(),
      sourceIdentity: identityRef.current,
      target: () => ({ profileId: 'profile-a', sessionId: 'session-a' }),
    });
    await actions.reactivateSession({
      id: 'session-a', adapterId: 'codex-cli', title: 'Dormant', source: 'sdk',
      lifecycle: 'dormant', activity: 'idle', archived: false, pinned: false,
      createdAt: 1, updatedAt: 2, endedAt: 2, model: null, thinking: null,
      runtimeProvider: null, context: null, spawnedBy: null, spawnDepth: 0,
      teams: [], summary: null, summaryGenerationSource: null, workspaceLabel: 'Workspace',
      contextOnly: false,
    });

    expect(requireCapability).toHaveBeenCalledWith('sessions.reactivate');
    expect(reactivateRemoteHostSession).toHaveBeenCalledWith(expect.objectContaining({
      expectedAuthority: { authoritativeCoreId: 'core-a', workerGeneration: 1 },
      expectedUpdatedAt: 2,
      intentId: 'intent-r',
    }));
  });
});
