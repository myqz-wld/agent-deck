import { describe, expect, it, vi } from 'vitest';

import type { AgentAdapter, AdapterContext } from './types';
import {
  initializeProviderRuntimeCore,
  type ProviderRuntimeCompositionHost,
  type ProviderSessionClose,
  type ProviderSessionRename,
} from './provider-runtime-core';

function adapter(
  id: string,
  overrides: Partial<AgentAdapter> = {},
): AgentAdapter {
  return {
    id,
    displayName: id,
    capabilities: {
      canCreateSession: false,
      canForkSession: false,
      canInterrupt: false,
      canSendMessage: false,
      canInstallHooks: false,
      canRespondPermission: false,
      canSetPermissionMode: false,
      canSetCodexApprovalPolicy: false,
      canSetSessionMode: false,
      canRestartWithPermissionMode: false,
      canSetCodexSandbox: false,
      canRestartWithClaudeCodeSandbox: false,
      canRestartWithGrokSandbox: false,
      canCloseSession: false,
      canCollaborate: false,
      canAcceptAttachments: false,
    },
    init: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fixture() {
  const first = adapter('claude-code');
  const closeSession = vi.fn(async () => undefined);
  const second = adapter('codex-cli', { closeSession });
  const register = vi.fn();
  const get = vi.fn((id: string) =>
    [first, second].find((candidate) => candidate.id === id));
  const initAll = vi.fn(async () => [
    { id: first.id, ok: true },
    { id: second.id, ok: false, err: new Error('provider-private') },
  ]);
  let close: ProviderSessionClose | null = null;
  let rename: ProviderSessionRename | null = null;
  const host: ProviderRuntimeCompositionHost = {
    registry: { register, get, initAll },
    adapters: [first, second],
    installSessionClose: vi.fn((handler) => { close = handler; }),
    installSessionRename: vi.fn((handler) => { rename = handler; }),
    renameLiveSession: vi.fn(),
    reportAdapterInitFailure: vi.fn(),
  };
  return {
    first,
    second,
    closeSession,
    register,
    get,
    initAll,
    host,
    context: {} as AdapterContext,
    close: () => close,
    rename: () => rename,
  };
}

describe('provider runtime composition Core', () => {
  it('registers providers in declared order and preserves partial-init results', async () => {
    const state = fixture();
    const results = await initializeProviderRuntimeCore(state.host, state.context);

    expect(state.register.mock.calls).toEqual([
      [state.first],
      [state.second],
    ]);
    expect(state.initAll).toHaveBeenCalledWith(state.context);
    expect(results.map((result) => [result.id, result.ok])).toEqual([
      ['claude-code', true],
      ['codex-cli', false],
    ]);
    expect(state.host.reportAdapterInitFailure).toHaveBeenCalledOnce();
    expect(state.host.reportAdapterInitFailure).toHaveBeenCalledWith(results[1]);
  });

  it('routes close through the registered adapter without inventing a fallback', async () => {
    const state = fixture();
    await initializeProviderRuntimeCore(state.host, state.context);

    await state.close()?.('codex-cli', 'session-a');
    await state.close()?.('missing', 'session-b');

    expect(state.closeSession).toHaveBeenCalledOnce();
    expect(state.closeSession).toHaveBeenCalledWith('session-a');
  });

  it('delegates live rename policy to the owning host with the exact adapter', async () => {
    const state = fixture();
    await initializeProviderRuntimeCore(state.host, state.context);

    state.rename()?.('codex-cli', 'old', 'new');

    expect(state.host.renameLiveSession).toHaveBeenCalledWith(
      'codex-cli',
      state.second,
      'old',
      'new',
    );
  });

  it('does not publish lifecycle hooks when registration fails', async () => {
    const state = fixture();
    state.register.mockImplementationOnce(() => {
      throw new Error('duplicate adapter');
    });

    await expect(
      initializeProviderRuntimeCore(state.host, state.context),
    ).rejects.toThrow('duplicate adapter');
    expect(state.initAll).not.toHaveBeenCalled();
    expect(state.host.installSessionClose).not.toHaveBeenCalled();
    expect(state.host.installSessionRename).not.toHaveBeenCalled();
  });
});
