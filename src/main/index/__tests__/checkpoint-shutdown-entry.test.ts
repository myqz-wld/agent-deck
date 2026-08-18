import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AppHandler = (...args: unknown[]) => void;

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const handlers = new Map<string, AppHandler>();
  const checkpointState: { resolve: (() => void) | null } = { resolve: null };
  const watcherState: {
    mode: 'resolve' | 'reject' | 'drain-timeout' | 'pending';
    resolve: (() => void) | null;
  } = { mode: 'resolve', resolve: null };
  const remoteHostState: {
    mode: 'resolve' | 'reject' | 'pending';
    resolve: (() => void) | null;
  } = { mode: 'resolve', resolve: null };
  const checkpointStop = vi.fn(() => {
    calls.push('checkpoint.stop.begin');
    return new Promise<void>((resolve) => {
      checkpointState.resolve = () => {
        calls.push('checkpoint.stop.end');
        resolve();
      };
    });
  });
  const watcherStop = vi.fn(() => {
    calls.push('watcher.stop.begin');
    if (watcherState.mode === 'reject') {
      return Promise.reject(new Error('watcher drain failed'));
    }
    if (watcherState.mode === 'drain-timeout') {
      return Promise.resolve({
        drained: false,
        timedOut: true,
        activeDeliveries: 1,
        durableDelivering: 1,
      });
    }
    if (watcherState.mode === 'pending') {
      return new Promise((resolve) => {
        watcherState.resolve = () => {
          calls.push('watcher.stop.end');
          resolve({
            drained: true,
            timedOut: false,
            activeDeliveries: 0,
            durableDelivering: 0,
          });
        };
      });
    }
    return Promise.resolve({
      drained: true,
      timedOut: false,
      activeDeliveries: 0,
      durableDelivering: 0,
    });
  });
  const remoteHostStop = vi.fn(() => {
    calls.push('remote.stop.begin');
    if (remoteHostState.mode === 'reject') {
      return Promise.reject(new Error('remote transport retirement failed'));
    }
    if (remoteHostState.mode === 'pending') {
      return new Promise<void>((resolve) => {
        remoteHostState.resolve = () => {
          calls.push('remote.stop.end');
          resolve();
        };
      });
    }
    calls.push('remote.stop.end');
    return Promise.resolve();
  });
  const summaryState: { resolve: (() => void) | null } = { resolve: null };
  const summaryStop = vi.fn(() => {
    calls.push('summary.stop.begin');
    return new Promise<void>((resolve) => {
      summaryState.resolve = () => {
        calls.push('summary.stop.end');
        resolve();
      };
    });
  });
  return {
    calls,
    handlers,
    checkpointState,
    checkpointStop,
    watcherState,
    watcherStop,
    remoteHostState,
    remoteHostStop,
    summaryState,
    summaryStop,
  };
});

vi.mock('electron', () => ({
  app: {
    on: vi.fn((event: string, handler: AppHandler) => {
      mocks.handlers.set(event, handler);
    }),
    quit: vi.fn(),
    exit: vi.fn(() => mocks.calls.push('app.exit')),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  globalShortcut: { unregisterAll: vi.fn() },
}));
vi.mock('../../store/db', () => ({
  closeDb: vi.fn(() => mocks.calls.push('db.close')),
}));
vi.mock('../../adapters/registry', () => ({
  adapterRegistry: {
    shutdownAll: vi.fn(async () => {
      mocks.calls.push('adapters.shutdown');
      return [];
    }),
  },
}));
vi.mock('../../session/lifecycle-scheduler', () => ({ setLifecycleScheduler: vi.fn() }));
vi.mock('../../store/issue-lifecycle-scheduler', () => ({ setIssueLifecycleScheduler: vi.fn() }));
vi.mock('../../store/message-lifecycle-scheduler', () => ({ setMessageLifecycleScheduler: vi.fn() }));
vi.mock('../../session/summarizer/desktop', () => ({
  summarizer: { stop: mocks.summaryStop },
}));
vi.mock('../../session/continuation-context/checkpoint-refresh-service', () => ({
  stopContinuationCheckpointRefreshService: mocks.checkpointStop,
}));
vi.mock('../../notify/sound', () => ({ stopAllSounds: vi.fn() }));
vi.mock('../../teams/universal-message-watcher', () => ({
  universalMessageWatcher: { stop: mocks.watcherStop },
}));
vi.mock('../../browser-use/engine/registry', () => ({
  getBrowserEngine: vi.fn(() => ({ disposeAll: vi.fn(async () => undefined) })),
}));
vi.mock('../../remote-host', () => ({
  shutdownRemoteHostServiceIfCreated: mocks.remoteHostStop,
}));
vi.mock('../../cli', () => ({ handleCliArgv: vi.fn() }));
vi.mock('../../ipc/session-hand-off', () => ({
  cleanupSessionHandOffPreparations: vi.fn(() => mocks.calls.push('handoff-spool.cleanup')),
}));
vi.mock('@main/utils/logger', () => ({
  default: {
    scope: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    warn: vi.fn(),
  },
}));

import { app } from 'electron';
import { cleanupSessionHandOffPreparations } from '../../ipc/session-hand-off';
import { closeDb } from '../../store/db';
import { createInitialBootstrapState } from '../_deps';
import { registerLifecycleHooks } from '../lifecycle-hooks';
import {
  hasAppShutdownBegun,
  resetAppShutdownForTests,
} from '../shutdown-state';

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

describe('checkpoint refresh shutdown entry', () => {
  let exitSpy: { mockRestore: () => void };

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.calls.length = 0;
    mocks.handlers.clear();
    mocks.checkpointState.resolve = null;
    mocks.watcherState.mode = 'resolve';
    mocks.watcherState.resolve = null;
    mocks.remoteHostState.mode = 'resolve';
    mocks.remoteHostState.resolve = null;
    mocks.summaryState.resolve = null;
    resetAppShutdownForTests();
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code) => {
      mocks.calls.push(`process.exit.${code ?? ''}`);
      return undefined as never;
    }));
    registerLifecycleHooks(createInitialBootstrapState(), Promise.resolve());
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.useRealTimers();
  });

  it('awaits refresh drain before clearing the shared hand-off spool and closing SQLite', async () => {
    const preventDefault = vi.fn();
    mocks.handlers.get('before-quit')?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(hasAppShutdownBegun()).toBe(true);
    expect(mocks.checkpointStop).toHaveBeenCalledOnce();
    expect(cleanupSessionHandOffPreparations).not.toHaveBeenCalled();
    expect(closeDb).not.toHaveBeenCalled();

    mocks.checkpointState.resolve?.();
    mocks.summaryState.resolve?.();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(cleanupSessionHandOffPreparations).toHaveBeenCalledOnce();
    expect(closeDb).toHaveBeenCalledOnce();
    expect(mocks.calls).toEqual([
      'watcher.stop.begin',
      'checkpoint.stop.begin',
      'remote.stop.begin',
      'remote.stop.end',
      'summary.stop.begin',
      'checkpoint.stop.end',
      'summary.stop.end',
      'handoff-spool.cleanup',
      'adapters.shutdown',
      'db.close',
      'app.exit',
    ]);
    expect(app.exit).toHaveBeenCalledWith(0);
  });

  it('on the bounded timeout, preserves the spool instead of deleting a source still owned by refresh', async () => {
    mocks.handlers.get('before-quit')?.({ preventDefault: vi.fn() });

    mocks.summaryState.resolve?.();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(cleanupSessionHandOffPreparations).not.toHaveBeenCalled();
    expect(closeDb).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(cleanupSessionHandOffPreparations).not.toHaveBeenCalled();
    expect(closeDb).toHaveBeenCalledOnce();
    expect(mocks.calls).toContain('process.exit.1');
  });

  it('awaits the watcher drain before adapter shutdown and closeDb', async () => {
    mocks.watcherState.mode = 'pending';
    mocks.handlers.get('before-quit')?.({ preventDefault: vi.fn() });
    mocks.checkpointState.resolve?.();
    mocks.summaryState.resolve?.();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(mocks.watcherStop).toHaveBeenCalledOnce();
    expect(mocks.calls).not.toContain('adapters.shutdown');
    expect(closeDb).not.toHaveBeenCalled();

    mocks.watcherState.resolve?.();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(mocks.calls.indexOf('watcher.stop.end')).toBeLessThan(
      mocks.calls.indexOf('adapters.shutdown'),
    );
    expect(mocks.calls.indexOf('adapters.shutdown')).toBeLessThan(
      mocks.calls.indexOf('db.close'),
    );
  });

  it('awaits remote SSH retirement before adapter shutdown and closeDb', async () => {
    mocks.remoteHostState.mode = 'pending';
    mocks.handlers.get('before-quit')?.({ preventDefault: vi.fn() });
    mocks.checkpointState.resolve?.();
    mocks.summaryState.resolve?.();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(mocks.remoteHostStop).toHaveBeenCalledOnce();
    expect(mocks.calls).not.toContain('adapters.shutdown');
    expect(closeDb).not.toHaveBeenCalled();

    mocks.remoteHostState.resolve?.();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(mocks.calls.indexOf('remote.stop.end')).toBeLessThan(
      mocks.calls.indexOf('adapters.shutdown'),
    );
    expect(mocks.calls.indexOf('adapters.shutdown')).toBeLessThan(
      mocks.calls.indexOf('db.close'),
    );
  });

  it('prevents reentrant quit events while sharing one cleanup operation', async () => {
    mocks.remoteHostState.mode = 'pending';
    const firstEvent = { preventDefault: vi.fn() };
    const secondEvent = { preventDefault: vi.fn() };
    const handler = mocks.handlers.get('before-quit');

    handler?.(firstEvent);
    handler?.(secondEvent);
    mocks.checkpointState.resolve?.();
    mocks.summaryState.resolve?.();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(secondEvent.preventDefault).toHaveBeenCalledOnce();
    expect(mocks.remoteHostStop).toHaveBeenCalledOnce();
    expect(closeDb).not.toHaveBeenCalled();
    expect(app.exit).not.toHaveBeenCalled();

    mocks.remoteHostState.resolve?.();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(mocks.remoteHostStop).toHaveBeenCalledOnce();
    expect(closeDb).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledOnce();
  });

  it('treats remote SSH retirement failure as degraded and still closes SQLite', async () => {
    mocks.remoteHostState.mode = 'reject';
    mocks.handlers.get('before-quit')?.({ preventDefault: vi.fn() });
    mocks.checkpointState.resolve?.();
    mocks.summaryState.resolve?.();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(mocks.remoteHostStop).toHaveBeenCalledOnce();
    expect(closeDb).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(0);
  });

  it.each(['reject', 'drain-timeout'] as const)(
    'marks watcher %s as degraded and still closes SQLite',
    async (mode) => {
      mocks.watcherState.mode = mode;
      mocks.handlers.get('before-quit')?.({ preventDefault: vi.fn() });
      mocks.checkpointState.resolve?.();
      mocks.summaryState.resolve?.();
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks();

      expect(closeDb).toHaveBeenCalledOnce();
      expect(app.exit).toHaveBeenCalledWith(0);
    },
  );

  it('keeps a pending watcher drain inside the existing 10s cleanup bound', async () => {
    mocks.watcherState.mode = 'pending';
    mocks.handlers.get('before-quit')?.({ preventDefault: vi.fn() });
    mocks.checkpointState.resolve?.();
    mocks.summaryState.resolve?.();
    await vi.advanceTimersByTimeAsync(9_999);
    await flushMicrotasks();

    expect(closeDb).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(closeDb).toHaveBeenCalledOnce();
    expect(mocks.calls).toContain('process.exit.1');
  });

  it('keeps a pending storage-worker stop inside the 10s bound', async () => {
    const storageStop = vi.fn(() => new Promise<void>(() => undefined));
    const state = createInitialBootstrapState();
    state.storageMaintenanceScheduler = {
      stop: storageStop,
    } as unknown as NonNullable<typeof state.storageMaintenanceScheduler>;
    registerLifecycleHooks(state, Promise.resolve());

    mocks.handlers.get('before-quit')?.({ preventDefault: vi.fn() });
    mocks.checkpointState.resolve?.();
    mocks.summaryState.resolve?.();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(storageStop).toHaveBeenCalledOnce();
    expect(state.storageMaintenanceScheduler).toBeNull();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(closeDb).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(closeDb).toHaveBeenCalledOnce();
    expect(mocks.calls).toContain('process.exit.1');
  });
});
