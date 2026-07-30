import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { MIGRATIONS } from '../migrations';
import {
  compareAndSetPhaseWithDb,
  createEnterWithDb,
  markEnterCreatedWithDb,
} from '../worktree-transition-repo';
import { appendWorktreeTransitionInputWithDb } from '../worktree-transition-input-repo';
import { bindingAvailable } from './_binding-probe';

let currentDb: BetterSqlite3.Database | null = null;

vi.mock('../db', () => ({
  getDb: () => {
    if (!currentDb) throw new Error('worktree lifecycle test database is unavailable');
    return currentDb;
  },
  isDbInitialized: () => currentDb !== null,
}));

import {
  assertWorktreeTransitionAllowsDelete,
  mayClearLegacyWorktreeMarker,
} from '@main/session/worktree-transition/lifecycle-policy';
import {
  batchDeleteHistory,
  findHistoryOlderThan,
} from '../session-repo/lifecycle';
import { _delete as deleteSession } from '../session-repo/core-crud';

function insertClosedSession(id: string): void {
  currentDb!.prepare(
    `INSERT INTO sessions
       (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at,
        ended_at, archived_at)
     VALUES (?, 'codex-cli', '/repo', ?, 'sdk', 'closed', 'idle', 1, 1, 2, 2)`,
  ).run(id, id);
}

describe.skipIf(!bindingAvailable)('structured worktree lifecycle retention', () => {
  beforeEach(() => {
    currentDb = new Database(':memory:');
    for (const migration of MIGRATIONS) currentDb.exec(migration.sql);
  });

  afterEach(() => {
    currentDb?.close();
    currentDb = null;
  });

  it('retains cleanup authority across close/archive and excludes it from history purge', () => {
    insertClosedSession('session-a');
    const creating = createEnterWithDb(currentDb!, {
      sessionId: 'session-a',
      originalCwd: '/repo',
      targetCwd: '/repo/.agent-deck/worktrees/task',
      mainRepo: '/repo',
      worktreePath: '/repo/.agent-deck/worktrees/task',
      workBranch: 'agent-deck/task',
      baseBranch: 'main',
      baseCommit: 'a'.repeat(40),
      toolUseId: 'tool-enter',
      continuationKey: 'cwd:test:1',
      requestedAt: 10,
    });
    markEnterCreatedWithDb(currentDb!, 'session-a', creating.generation, 11);

    expect(mayClearLegacyWorktreeMarker('session-a')).toBe(false);
    expect(() => assertWorktreeTransitionAllowsDelete('session-a')).toThrow(
      'Exit or recover the worktree transition first',
    );
    expect(() => deleteSession('session-a')).toThrow(
      'Cannot delete session session-a while worktree transition',
    );
    expect(findHistoryOlderThan(100)).toEqual([]);
    expect(
      batchDeleteHistory(
        [{ id: 'session-a', cliSessionId: null, lastEventAt: 1 }],
        100,
      ),
    ).toEqual([]);
    expect(
      currentDb!.prepare(`SELECT cwd_release_marker FROM sessions WHERE id = ?`)
        .pluck()
        .get('session-a'),
    ).toBe('/repo/.agent-deck/worktrees/task');
  });

  it('allows marker cleanup and history deletion only after the lease is cleared', () => {
    insertClosedSession('session-a');
    const creating = createEnterWithDb(currentDb!, {
      sessionId: 'session-a',
      originalCwd: '/repo',
      targetCwd: '/repo/.agent-deck/worktrees/task',
      mainRepo: '/repo',
      worktreePath: '/repo/.agent-deck/worktrees/task',
      workBranch: 'agent-deck/task',
      baseBranch: 'main',
      baseCommit: 'a'.repeat(40),
      toolUseId: 'tool-enter',
      continuationKey: 'cwd:test:1',
      requestedAt: 10,
    });
    markEnterCreatedWithDb(currentDb!, 'session-a', creating.generation, 11);
    appendWorktreeTransitionInputWithDb(currentDb!, {
      sessionId: 'session-a',
      generation: creating.generation,
      agentId: 'codex-cli',
      text: 'settled input',
      createdAt: 11,
    });
    compareAndSetPhaseWithDb(currentDb!, {
      sessionId: 'session-a',
      generation: creating.generation,
      expected: 'enter_waiting_tool_result',
      next: 'cleared',
      updatedAt: 12,
    });

    expect(mayClearLegacyWorktreeMarker('session-a')).toBe(true);
    expect(() => assertWorktreeTransitionAllowsDelete('session-a')).not.toThrow();
    expect(findHistoryOlderThan(100).map((row) => row.id)).toEqual(['session-a']);
    expect(
      batchDeleteHistory(
        [{ id: 'session-a', cliSessionId: null, lastEventAt: 1 }],
        100,
      ).map((row) => row.id),
    ).toEqual(['session-a']);
    expect(
      currentDb!.prepare(
        `SELECT COUNT(*) FROM worktree_cwd_transitions WHERE session_id = ?`,
      ).pluck().get('session-a'),
    ).toBe(0);
    expect(
      currentDb!.prepare(
        `SELECT COUNT(*) FROM worktree_cwd_transition_inputs WHERE session_id = ?`,
      ).pluck().get('session-a'),
    ).toBe(0);
  });
});
