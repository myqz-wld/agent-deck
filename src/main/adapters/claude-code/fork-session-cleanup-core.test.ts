import { describe, expect, it, vi } from 'vitest';
import {
  ClaudeForkDiscardError,
  createClaudeForkCleanupCore,
  type ClaudeForkCleanupInput,
} from './fork-session-cleanup-core';

function cleanupInput(overrides: Partial<ClaudeForkCleanupInput> = {}): ClaudeForkCleanupInput {
  return {
    providerName: 'Claude',
    cwd: '/repo',
    sourceIds: new Set(['source-app', 'source-native']),
    applicationChildIds: new Set(['source-app', 'child-app']),
    nativeChildIds: new Set(['source-native']),
    closeChild: vi.fn(async () => undefined),
    store: {
      get: vi.fn(() => ({ cliSessionId: 'child-native' })),
      delete: vi.fn(),
    },
    sdk: { deleteSession: vi.fn(async () => undefined) },
    ...overrides,
  };
}

describe('Claude fork cleanup Core', () => {
  it('protects source identities and completes every child cleanup phase', async () => {
    const input = cleanupInput();
    const observer = { recordIssue: vi.fn() };
    const cleanup = createClaudeForkCleanupCore(input, observer);

    await cleanup();

    expect(input.store.get).toHaveBeenCalledOnce();
    expect(input.store.get).toHaveBeenCalledWith('child-app');
    expect(input.closeChild).toHaveBeenCalledWith('child-app');
    expect(input.store.delete).toHaveBeenCalledWith('child-app');
    expect(input.sdk.deleteSession).toHaveBeenCalledWith('child-native', { dir: '/repo' });
    expect(input.closeChild).not.toHaveBeenCalledWith('source-app');
    expect(input.sdk.deleteSession).not.toHaveBeenCalledWith('source-native', expect.anything());
    expect(observer.recordIssue).not.toHaveBeenCalled();
  });

  it('memoizes one exhaustive failure and preserves its authoritative issue set', async () => {
    const input = cleanupInput({
      nativeChildIds: new Set(['source-native', 'child-native']),
      closeChild: vi.fn(async () => { throw new Error('close failed'); }),
      deleteChild: vi.fn(async () => { throw new Error('delete failed'); }),
      store: {
        get: vi.fn(() => { throw new Error('inspect failed'); }),
        delete: vi.fn(),
      },
      sdk: {
        deleteSession: vi.fn(async () => { throw new Error('native failed'); }),
      },
    });
    const observer = {
      recordIssue: vi.fn(() => { throw new Error('observer failed'); }),
    };
    const cleanup = createClaudeForkCleanupCore(input, observer);
    const first = cleanup();
    const second = cleanup();

    expect(first).toBe(second);
    let thrown: unknown;
    try {
      await first;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ClaudeForkDiscardError);
    expect((thrown as ClaudeForkDiscardError).issues).toEqual([
      { phase: 'inspect-row', targetId: 'child-app' },
      { phase: 'close-child', targetId: 'child-app' },
      { phase: 'delete-row', targetId: 'child-app' },
      { phase: 'delete-native', targetId: 'child-native' },
    ]);
    expect((thrown as ClaudeForkDiscardError).residualState).toEqual([
      'claude-fork-child-artifacts',
    ]);
    expect(input.closeChild).toHaveBeenCalledOnce();
    expect(input.deleteChild).toHaveBeenCalledOnce();
    expect(input.sdk.deleteSession).toHaveBeenCalledOnce();
    expect(observer.recordIssue).toHaveBeenCalledTimes(4);
  });
});
