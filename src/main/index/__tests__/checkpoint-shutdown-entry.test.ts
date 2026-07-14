import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AppHandler = (...args: unknown[]) => void;

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const handlers = new Map<string, AppHandler>();
  const checkpointState: { resolve: (() => void) | null } = { resolve: null };
  const checkpointStop = vi.fn(() => {
    calls.push('checkpoint.stop.begin');
    return new Promise<void>((resolve) => {
      checkpointState.resolve = () => {
        calls.push('checkpoint.stop.end');
        resolve();
      };
    });
  });
  return { calls, handlers, checkpointState, checkpointStop };
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
  getDb: vi.fn(() => ({ name: '/tmp/checkpoint-entry-test.sqlite' })),
}));
vi.mock('../../store/storage-maintenance/shutdown-tasks', () => ({
  hasPendingStorageShutdownTasks: vi.fn(() => false),
}));
vi.mock('../../store/storage-maintenance/shutdown-runner', () => ({
  runStorageShutdownMaintenance: vi.fn(),
}));
vi.mock('../../adapters/registry', () => ({
  adapterRegistry: { shutdownAll: vi.fn(async () => []) },
}));
vi.mock('../../session/lifecycle-scheduler', () => ({ setLifecycleScheduler: vi.fn() }));
vi.mock('../../teams/team-lifecycle-scheduler', () => ({ setTeamLifecycleScheduler: vi.fn() }));
vi.mock('../../store/issue-lifecycle-scheduler', () => ({ setIssueLifecycleScheduler: vi.fn() }));
vi.mock('../../store/message-lifecycle-scheduler', () => ({ setMessageLifecycleScheduler: vi.fn() }));
vi.mock('../../store/token-usage-lifecycle-scheduler', () => ({ setTokenUsageLifecycleScheduler: vi.fn() }));
vi.mock('../../session/summarizer', () => ({ summarizer: { stop: vi.fn() } }));
vi.mock('../../session/continuation-context/checkpoint-refresh-service', () => ({
  stopContinuationCheckpointRefreshService: mocks.checkpointStop,
}));
vi.mock('../../notify/sound', () => ({ stopAllSounds: vi.fn() }));
vi.mock('../../teams/universal-message-watcher', () => ({
  universalMessageWatcher: { stop: vi.fn() },
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
    expect(mocks.checkpointStop).toHaveBeenCalledOnce();
    expect(cleanupSessionHandOffPreparations).not.toHaveBeenCalled();
    expect(closeDb).not.toHaveBeenCalled();

    mocks.checkpointState.resolve?.();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(cleanupSessionHandOffPreparations).toHaveBeenCalledOnce();
    expect(closeDb).toHaveBeenCalledOnce();
    expect(mocks.calls).toEqual([
      'checkpoint.stop.begin',
      'checkpoint.stop.end',
      'handoff-spool.cleanup',
      'db.close',
      'app.exit',
    ]);
    expect(app.exit).toHaveBeenCalledWith(0);
  });

  it('on the bounded timeout, preserves the spool instead of deleting a source still owned by refresh', async () => {
    mocks.handlers.get('before-quit')?.({ preventDefault: vi.fn() });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(cleanupSessionHandOffPreparations).not.toHaveBeenCalled();
    expect(closeDb).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(cleanupSessionHandOffPreparations).not.toHaveBeenCalled();
    expect(closeDb).toHaveBeenCalledOnce();
    expect(mocks.calls).toContain('process.exit.1');
  });
});
