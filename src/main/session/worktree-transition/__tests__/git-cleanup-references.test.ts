import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifecycleState } from '@shared/types/session';
import type { WorktreeTransitionRecord } from '../types';

interface SessionRow {
  id: string;
  cwd: string;
  lifecycle: LifecycleState;
}

const harness = vi.hoisted(() => ({
  sessions: [] as SessionRow[],
  adapters: [] as Array<{
    id: string;
    getRuntimeCwd?: (sessionId: string) => string | null;
  }>,
  leases: [] as WorktreeTransitionRecord[],
  worktreeExists: false,
  beforeClosedRelease: null as (() => void) | null,
  runGit: vi.fn(),
}));

vi.mock('@main/store/db', () => ({
  getDb: () => ({
    transaction: (operation: () => unknown) => operation,
    prepare: (sql: string) => ({
      all: () =>
        sql.includes('SELECT id, cwd, lifecycle')
          ? harness.sessions
          : harness.sessions.map(({ id }) => ({ id })),
      get: (id: string) => harness.sessions.find((row) => row.id === id),
      run: (cwd: string, id: string, expectedCwd: string) => {
        if (sql.includes('UPDATE sessions')) {
          const beforeClosedRelease = harness.beforeClosedRelease;
          harness.beforeClosedRelease = null;
          beforeClosedRelease?.();
        }
        const row = harness.sessions.find(
          (candidate) =>
            candidate.id === id &&
            candidate.cwd === expectedCwd &&
            candidate.lifecycle === 'closed',
        );
        if (!sql.includes('UPDATE sessions') || !row) return { changes: 0 };
        row.cwd = cwd;
        return { changes: 1 };
      },
    }),
  }),
}));

vi.mock('@main/adapters/registry', () => ({
  adapterRegistry: {
    list: () => harness.adapters,
  },
}));

vi.mock('@main/store/worktree-transition-repo', () => ({
  worktreeTransitionRepo: {
    listRecoverable: () => harness.leases,
  },
}));

vi.mock(
  '@main/agent-deck-mcp/tools/handlers/_shared/default-impl-deps',
  () => ({
    existsSyncDefault: () => harness.worktreeExists,
    realpathSyncDefault: (value: string) => value,
    runGitDefault: harness.runGit,
  }),
);

import { cleanupStructuredWorktree } from '../git-cleanup';

const WORKTREE = '/repo/.agent-deck/worktrees/w1';

function transition(
  sessionId = 'owner',
  phase: WorktreeTransitionRecord['phase'] = 'cleanup_pending',
): WorktreeTransitionRecord {
  return {
    sessionId,
    generation: 1,
    direction: 'exit',
    phase,
    originalCwd: '/repo',
    targetCwd: '/repo',
    mainRepo: '/repo',
    worktreePath: WORKTREE,
    baseCommit: 'a'.repeat(40),
    toolUseId: null,
    continuationKey: 'worktree:test',
    continuationDelivered: true,
    discardChanges: false,
    requestedAt: 1,
    updatedAt: 1,
    lastError: null,
  };
}

beforeEach(() => {
  harness.sessions.length = 0;
  harness.adapters.length = 0;
  harness.leases.length = 0;
  harness.worktreeExists = false;
  harness.beforeClosedRelease = null;
  harness.runGit.mockReset();
});

describe('structured worktree cleanup references', () => {
  it('releases a closed historical cwd to the restored repository', async () => {
    harness.sessions.push({
      id: 'closed-reviewer',
      cwd: WORKTREE,
      lifecycle: 'closed',
    });

    await expect(cleanupStructuredWorktree(transition())).resolves.toEqual({
      worktreeRemoved: false,
    });
    expect(harness.sessions[0]?.cwd).toBe('/repo');
  });

  it.each<LifecycleState>(['active', 'dormant'])(
    'keeps a %s persisted cwd as a cleanup fence',
    async (lifecycle) => {
      harness.sessions.push({
        id: `${lifecycle}-reviewer`,
        cwd: WORKTREE,
        lifecycle,
      });

      await expect(cleanupStructuredWorktree(transition())).rejects.toThrow(
        `${lifecycle}-reviewer`,
      );
    },
  );

  it('still fences a live runtime owned by a closed session', async () => {
    harness.sessions.push({
      id: 'closed-reviewer',
      cwd: WORKTREE,
      lifecycle: 'closed',
    });
    harness.adapters.push({
      id: 'codex-cli',
      getRuntimeCwd: (sessionId) =>
        sessionId === 'closed-reviewer' ? WORKTREE : null,
    });

    await expect(cleanupStructuredWorktree(transition())).rejects.toThrow(
      'codex-cli:closed-reviewer',
    );
    expect(harness.sessions[0]?.cwd).toBe(WORKTREE);
  });

  it('still fences an unsettled lease owned by a closed session', async () => {
    harness.sessions.push({
      id: 'closed-reviewer',
      cwd: WORKTREE,
      lifecycle: 'closed',
    });
    harness.leases.push(transition('closed-reviewer', 'active'));

    await expect(cleanupStructuredWorktree(transition())).rejects.toThrow(
      'closed-reviewer:1:active',
    );
    expect(harness.sessions[0]?.cwd).toBe(WORKTREE);
  });

  it('fails closed if a historical session reactivates during release', async () => {
    harness.sessions.push({
      id: 'closed-reviewer',
      cwd: WORKTREE,
      lifecycle: 'closed',
    });
    harness.beforeClosedRelease = () => {
      harness.sessions[0]!.lifecycle = 'active';
    };

    await expect(cleanupStructuredWorktree(transition())).rejects.toThrow(
      'closed session closed-reviewer changed while releasing',
    );
    expect(harness.sessions[0]?.cwd).toBe(WORKTREE);
  });
});
