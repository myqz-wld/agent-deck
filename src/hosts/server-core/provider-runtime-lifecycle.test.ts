import { describe, expect, it, vi } from 'vitest';

import { ServerCoreProviderRuntimeLifecycle } from './provider-runtime-lifecycle';

function harness(overrides: Partial<{
  repositoryStart: () => Promise<void>;
  repositoryStop: (reason: string) => Promise<void>;
  metadataStart: () => void;
  metadataClose: () => void;
  brokerStart: () => Promise<void>;
  brokerStop: () => Promise<void>;
  desktopBrokerStart: () => Promise<void>;
  desktopBrokerStop: () => Promise<void>;
  browserRuntimeStart: () => Promise<void>;
  browserRuntimeStop: () => Promise<void>;
  presentationsStart: () => Promise<void>;
  presentationsStop: () => Promise<void>;
  collaborationStart: () => Promise<void>;
  collaborationStop: () => Promise<void>;
  worktreeStart: () => Promise<void>;
  worktreeStop: () => Promise<void>;
  initializeProviders: () => Promise<void>;
  retireProviders: () => Promise<void>;
  shutdownProviders: () => Promise<void>;
}> = {}) {
  const trace: string[] = [];
  const repositoryStart = vi.fn(overrides.repositoryStart ?? (async () => {
    trace.push('repository-start');
  }));
  const repositoryStop = vi.fn(overrides.repositoryStop ?? (async (reason: string) => {
    trace.push(`repository-stop:${reason}`);
  }));
  const metadataStart = vi.fn(overrides.metadataStart ?? (() => {
    trace.push('metadata-start');
  }));
  const metadataClose = vi.fn(overrides.metadataClose ?? (() => {
    trace.push('metadata-close');
  }));
  const brokerStart = vi.fn(overrides.brokerStart ?? (async () => {
    trace.push('broker-start');
  }));
  const brokerStop = vi.fn(overrides.brokerStop ?? (async () => {
    trace.push('broker-stop');
  }));
  const desktopBrokerStart = vi.fn(overrides.desktopBrokerStart ?? (async () => {
    trace.push('desktop-broker-start');
  }));
  const desktopBrokerStop = vi.fn(overrides.desktopBrokerStop ?? (async () => {
    trace.push('desktop-broker-stop');
  }));
  const browserRuntimeStart = vi.fn(overrides.browserRuntimeStart ?? (async () => {
    trace.push('browser-runtime-start');
  }));
  const browserRuntimeStop = vi.fn(overrides.browserRuntimeStop ?? (async () => {
    trace.push('browser-runtime-stop');
  }));
  const presentationsStart = vi.fn(overrides.presentationsStart ?? (async () => {
    trace.push('presentations-start');
  }));
  const presentationsStop = vi.fn(overrides.presentationsStop ?? (async () => {
    trace.push('presentations-stop');
  }));
  const collaborationStart = vi.fn(overrides.collaborationStart ?? (async () => {
    trace.push('collaboration-start');
  }));
  const collaborationStop = vi.fn(overrides.collaborationStop ?? (async () => {
    trace.push('collaboration-stop');
  }));
  const worktreeStart = vi.fn(overrides.worktreeStart ?? (async () => {
    trace.push('worktree-start');
  }));
  const worktreeStop = vi.fn(overrides.worktreeStop ?? (async () => {
    trace.push('worktree-stop');
  }));
  const initializeProviders = vi.fn(overrides.initializeProviders ?? (async () => {
    trace.push('provider-start');
  }));
  const retireProviders = vi.fn(overrides.retireProviders ?? (async () => {
    trace.push('provider-retire');
  }));
  const shutdownProviders = vi.fn(overrides.shutdownProviders ?? (async () => {
    trace.push('provider-shutdown');
  }));
  const diagnostics = { info: vi.fn(), warn: vi.fn() };
  const lifecycle = new ServerCoreProviderRuntimeLifecycle({
    repository: { start: repositoryStart, stop: repositoryStop },
    metadata: { start: metadataStart, close: metadataClose },
    mcpBroker: { start: brokerStart, stop: brokerStop },
    desktopBroker: { start: desktopBrokerStart, stop: desktopBrokerStop },
    browserRuntime: { start: browserRuntimeStart, stop: browserRuntimeStop },
    presentations: { start: presentationsStart, stop: presentationsStop },
    collaboration: { start: collaborationStart, stop: collaborationStop },
    worktrees: { start: worktreeStart, stop: worktreeStop },
    initializeProviders,
    retireProviders,
    shutdownProviders,
    diagnostics,
  });
  return {
    diagnostics,
    initializeProviders,
    lifecycle,
    metadataClose,
    repositoryStop,
    shutdownProviders,
    trace,
  };
}

describe('ServerCoreProviderRuntimeLifecycle', () => {
  it('starts and stops exactly once in ownership order', async () => {
    const state = harness();
    const firstStart = state.lifecycle.start();
    expect(state.lifecycle.start()).toBe(firstStart);
    await firstStart;
    const firstStop = state.lifecycle.stop('shutdown');
    expect(state.lifecycle.stop('again')).toBe(firstStop);
    await firstStop;

    expect(state.trace).toEqual([
      'repository-start',
      'metadata-start',
      'broker-start',
      'desktop-broker-start',
      'browser-runtime-start',
      'presentations-start',
      'provider-start',
      'worktree-start',
      'collaboration-start',
      'broker-stop',
      'browser-runtime-stop',
      'desktop-broker-stop',
      'presentations-stop',
      'collaboration-stop',
      'worktree-stop',
      'provider-retire',
      'provider-shutdown',
      'metadata-close',
      'repository-stop:shutdown',
    ]);
  });

  it('rolls back every acquired owner while preserving the startup error', async () => {
    const authoritative = new Error('authoritative-startup');
    const state = harness({
      initializeProviders: async () => { throw authoritative; },
      shutdownProviders: async () => { throw new Error('secondary-shutdown'); },
    });

    await expect(state.lifecycle.start()).rejects.toBe(authoritative);
    expect(state.shutdownProviders).toHaveBeenCalledOnce();
    expect(state.metadataClose).toHaveBeenCalledOnce();
    expect(state.repositoryStop).toHaveBeenCalledWith('startup-failed');
    expect(state.diagnostics.warn).toHaveBeenCalledWith(
      'provider startup rollback was incomplete',
    );
    await expect(state.lifecycle.stop('after-failure')).resolves.toBeUndefined();
  });

  it('attempts every cleanup and aggregates terminal failures', async () => {
    const state = harness({
      retireProviders: async () => { throw new Error('retire'); },
      shutdownProviders: async () => { throw new Error('shutdown'); },
      brokerStop: async () => { throw new Error('broker'); },
      metadataClose: () => { throw new Error('metadata'); },
      repositoryStop: async () => { throw new Error('repository'); },
    });
    await state.lifecycle.start();
    await expect(state.lifecycle.stop('shutdown')).rejects.toMatchObject({
      message: 'Server Core provider cleanup failed',
      errors: expect.arrayContaining([
        expect.objectContaining({ message: 'retire' }),
        expect.objectContaining({ message: 'shutdown' }),
        expect.objectContaining({ message: 'broker' }),
        expect.objectContaining({ message: 'metadata' }),
        expect.objectContaining({ message: 'repository' }),
      ]),
    });
    expect(state.metadataClose).toHaveBeenCalledOnce();
    expect(state.repositoryStop).toHaveBeenCalledOnce();
  });
});
