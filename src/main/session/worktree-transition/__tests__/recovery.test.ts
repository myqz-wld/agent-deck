import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeTransitionRecord } from '../types';

const harness = vi.hoisted(() => ({
  record: null as WorktreeTransitionRecord | null,
  cwd: '/repo',
  lifecycle: 'active',
  archivedAt: null as number | null,
  enqueue: vi.fn(async (..._args: unknown[]) => {}),
  release: vi.fn(),
  runtimeCwd: null as string | null,
  cleanup: vi.fn(async () => ({
    worktreeRemoved: true,
  })),
  rollback: vi.fn(async () => ({
    worktreeRemoved: true,
  })),
  status: vi.fn(),
  upsert: vi.fn(),
  delivered: false,
}));

vi.mock('@main/adapters/registry', () => ({
  adapterRegistry: {
    get: () => ({
      id: 'codex-cli',
      enqueueMessage: harness.enqueue,
      releaseCwdTransition: harness.release,
      getRuntimeCwd: () => harness.runtimeCwd,
    }),
  },
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: () => ({
      id: 'session-a',
      agentId: 'codex-cli',
      cwd: harness.cwd,
      lifecycle: harness.lifecycle,
      archivedAt: harness.archivedAt,
    }),
    setCwd: (_sessionId: string, cwd: string) => {
      harness.cwd = cwd;
    },
    setCwdReleaseMarker: vi.fn(),
  },
}));

vi.mock('@main/store/worktree-transition-input-repo', () => ({
  worktreeTransitionInputRepo: {
    listPending: () =>
      harness.delivered
        ? []
        : [
            {
              sessionId: 'session-a',
              generation: 3,
              sequence: 1,
              agentId: 'codex-cli',
              text: 'buffered',
              attachments: [],
              createdAt: 1,
              deliveredAt: null,
            },
          ],
    markDelivered: () => {
      harness.delivered = true;
      return true;
    },
  },
}));

vi.mock('@main/store/worktree-transition-repo', async (importOriginal) => {
  const original = await importOriginal<
    typeof import('@main/store/worktree-transition-repo')
  >();
  return {
    ...original,
    worktreeTransitionRepo: {
      get: () => harness.record,
      listRecoverable: () => (harness.record ? [harness.record] : []),
      compareAndSetPhase: (input: {
        expected: WorktreeTransitionRecord['phase'];
        next: WorktreeTransitionRecord['phase'];
        updatedAt: number;
        lastError?: string | null;
      }) => {
        if (!harness.record || harness.record.phase !== input.expected) {
          throw new Error('CAS mismatch');
        }
        harness.record = {
          ...harness.record,
          phase: input.next,
          direction: input.next === 'active' ? 'enter' : harness.record.direction,
          targetCwd:
            input.next === 'active'
              ? harness.record.worktreePath
              : harness.record.targetCwd,
          updatedAt: input.updatedAt,
          lastError: input.lastError ?? null,
        };
        return harness.record;
      },
      releaseLegacyExitAdoption: (input: {
        expected: WorktreeTransitionRecord['phase'];
        updatedAt: number;
        lastError: string;
      }) => {
        if (!harness.record || harness.record.phase !== input.expected) {
          throw new Error('legacy release mismatch');
        }
        harness.record = {
          ...harness.record,
          phase: 'cleared',
          targetCwd: harness.record.originalCwd,
          updatedAt: input.updatedAt,
          lastError: input.lastError,
        };
        return harness.record;
      },
      markContinuationDelivered: () => {
        if (harness.record) harness.record.continuationDelivered = true;
        return true;
      },
      setLastError: (
        _sessionId: string,
        _generation: number,
        error: string,
      ) => {
        if (harness.record) harness.record.lastError = error;
        return harness.record;
      },
    },
  };
});

vi.mock('../git-cleanup', () => ({
  cleanupStructuredWorktree: harness.cleanup,
  rollbackUnacknowledgedEnter: harness.rollback,
}));

vi.mock('../projection', () => ({
  emitWorktreeSessionUpsert: harness.upsert,
  emitWorktreeTransitionStatus: harness.status,
}));

import {
  reconcileWorktreeTransitionsAtStartup,
  recoverWorktreeTransition,
} from '../recovery';
import { WORKTREE_TRANSITION_CONTINUATION } from '../constants';

function record(
  phase: WorktreeTransitionRecord['phase'],
  direction: WorktreeTransitionRecord['direction'] = 'enter',
): WorktreeTransitionRecord {
  return {
    sessionId: 'session-a',
    formatVersion: 1,
    generation: 3,
    direction,
    phase,
    originalCwd: '/repo',
    targetCwd: direction === 'enter' ? '/repo/worktree' : '/repo',
    mainRepo: '/repo',
    worktreePath: '/repo/worktree',
    workBranch: '',
    baseBranch: '',
    baseCommit: 'a'.repeat(40),
    toolUseId: 'tool-a',
    continuationKey: 'cwd:test:3',
    continuationDelivered: false,
    discardChanges: false,
    deleteBranch: false,
    requestedAt: 1,
    updatedAt: 1,
    lastError: null,
  };
}

beforeEach(() => {
  harness.record = null;
  harness.cwd = '/repo';
  harness.lifecycle = 'active';
  harness.archivedAt = null;
  harness.runtimeCwd = null;
  harness.delivered = false;
  harness.enqueue.mockClear();
  harness.release.mockClear();
  harness.cleanup.mockReset();
  harness.cleanup.mockResolvedValue({
    worktreeRemoved: true,
  });
  harness.rollback.mockReset();
  harness.rollback.mockResolvedValue({
    worktreeRemoved: true,
  });
  harness.status.mockClear();
  harness.upsert.mockClear();
});

describe('worktree transition startup recovery', () => {
  it('rolls back an enter whose exact provider result was never observed', async () => {
    harness.record = record('enter_waiting_tool_result');
    await recoverWorktreeTransition('session-a');
    expect(harness.rollback).toHaveBeenCalledOnce();
    expect(harness.cwd).toBe('/repo');
    expect(harness.enqueue).toHaveBeenCalledOnce();
    expect(harness.enqueue).toHaveBeenCalledWith(
      'session-a',
      'buffered',
      [],
      expect.objectContaining({ userEventAlreadyPersisted: true }),
    );
    expect(harness.record.phase).toBe('cleared');
    expect(harness.status).toHaveBeenCalledWith(
      'session-a',
      expect.not.stringContaining('branch'),
      false,
      3,
    );
  });

  it('completes an acknowledged enter with continuation before buffered input', async () => {
    harness.record = record('interrupting_enter_turn');
    await recoverWorktreeTransition('session-a');
    expect(harness.cwd).toBe('/repo/worktree');
    expect(harness.enqueue.mock.calls.map((call) => call[1])).toEqual([
      WORKTREE_TRANSITION_CONTINUATION,
      'buffered',
    ]);
    expect(harness.record.phase).toBe('active');
    expect(harness.record.continuationDelivered).toBe(true);
  });

  it('reverts an exit whose provider result was not observed', async () => {
    harness.record = record('exit_waiting_tool_result', 'exit');
    harness.cwd = '/repo/worktree';
    await recoverWorktreeTransition('session-a');
    expect(harness.cleanup).not.toHaveBeenCalled();
    expect(harness.enqueue.mock.calls.map((call) => call[1])).toEqual([
      'buffered',
    ]);
    expect(harness.record).toMatchObject({
      phase: 'active',
      direction: 'enter',
      targetCwd: '/repo/worktree',
    });
  });

  it('returns an unacknowledged adopted exit to its legacy marker without changing cwd', async () => {
    harness.record = {
      ...record('exit_waiting_tool_result', 'exit'),
      continuationKey: 'worktree-cwd:legacy-exit:test-3',
    };
    harness.cwd = '/repo';
    await recoverWorktreeTransition('session-a');
    expect(harness.cleanup).not.toHaveBeenCalled();
    expect(harness.cwd).toBe('/repo');
    expect(harness.enqueue.mock.calls.map((call) => call[1])).toEqual([
      'buffered',
    ]);
    expect(harness.record).toMatchObject({
      phase: 'cleared',
      targetCwd: '/repo',
      lastError: expect.stringContaining('marker and worktree were retained'),
    });
    expect(harness.release).toHaveBeenCalledWith('session-a', 3);
  });

  it('restores original cwd but retains cleanup_pending on a second-check failure', async () => {
    harness.record = record('restoring_original_cwd', 'exit');
    harness.cwd = '/repo/worktree';
    harness.cleanup.mockRejectedValueOnce(new Error('dirty after acceptance'));
    await recoverWorktreeTransition('session-a');
    expect(harness.cwd).toBe('/repo');
    expect(harness.record.phase).toBe('cleanup_pending');
    expect(harness.record.lastError).toContain('dirty after acceptance');
    expect(harness.enqueue.mock.calls.map((call) => call[1])).toEqual([
      WORKTREE_TRANSITION_CONTINUATION,
      'buffered',
    ]);
  });

  it('reconciles open sessions before ingress and leaves closed sessions untouched', async () => {
    harness.record = record('active');
    harness.cwd = '/wrong';
    await expect(reconcileWorktreeTransitionsAtStartup()).resolves.toEqual({
      recovered: 1,
      skippedClosed: 0,
      failed: 0,
    });
    expect(harness.cwd).toBe('/repo/worktree');

    harness.record = record('enter_waiting_tool_result');
    harness.lifecycle = 'closed';
    await expect(reconcileWorktreeTransitionsAtStartup()).resolves.toEqual({
      recovered: 0,
      skippedClosed: 1,
      failed: 0,
    });
    expect(harness.rollback).not.toHaveBeenCalled();
  });
});
