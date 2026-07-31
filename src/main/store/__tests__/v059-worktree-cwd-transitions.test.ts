import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../migrations';
import {
  WorktreeTransitionConflictError,
  adoptLegacyExitWithDb,
  beginExitPreflightWithDb,
  compareAndSetPhaseWithDb,
  createEnterWithDb,
  markContinuationDeliveredWithDb,
  markEnterCreatedWithDb,
  releaseLegacyExitAdoptionWithDb,
  renameLeaseWithDb,
  transferActiveLeaseWithDb,
} from '../worktree-transition-repo';
import {
  appendWorktreeTransitionInputWithDb,
  listPendingWorktreeTransitionInputsWithDb,
  markWorktreeTransitionInputDeliveredWithDb,
} from '../worktree-transition-input-repo';
import { bindingAvailable } from './_binding-probe';

function migrate(db: Database.Database): void {
  for (const migration of MIGRATIONS) db.exec(migration.sql);
}

function insertSession(
  db: Database.Database,
  id: string,
  cwd = '/repo',
): void {
  db.prepare(
    `INSERT INTO sessions
       (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES (?, 'codex-cli', ?, ?, 'sdk', 'active', 'working', 1, 1)`,
  ).run(id, cwd, id);
}

function createEnter(
  db: Database.Database,
  sessionId = 'session-a',
) {
  return createEnterWithDb(db, {
    sessionId,
    originalCwd: '/repo',
    targetCwd: '/repo/.agent-deck/worktrees/task',
    mainRepo: '/repo',
    worktreePath: '/repo/.agent-deck/worktrees/task',
    baseCommit: 'a'.repeat(40),
    toolUseId: 'tool-enter',
    continuationKey: 'cwd-transition:session-a:enter:1',
    requestedAt: 10,
  });
}

function advanceToActive(
  db: Database.Database,
  sessionId = 'session-a',
) {
  const creating = createEnter(db, sessionId);
  markEnterCreatedWithDb(db, sessionId, creating.generation, 11);
  compareAndSetPhaseWithDb(db, {
    sessionId,
    generation: creating.generation,
    expected: 'enter_waiting_tool_result',
    next: 'interrupting_enter_turn',
    updatedAt: 12,
  });
  compareAndSetPhaseWithDb(db, {
    sessionId,
    generation: creating.generation,
    expected: 'interrupting_enter_turn',
    next: 'switching_to_worktree',
    updatedAt: 13,
  });
  return compareAndSetPhaseWithDb(db, {
    sessionId,
    generation: creating.generation,
    expected: 'switching_to_worktree',
    next: 'active',
    updatedAt: 14,
  });
}

describe.skipIf(!bindingAvailable)('v059 worktree cwd transitions', () => {
  it('adopts a detached legacy marker into an exit preflight atomically', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      insertSession(
        db,
        'session-a',
        '/repo/.agent-deck/worktrees/legacy',
      );
      db.prepare(
        `UPDATE sessions SET cwd_release_marker = ? WHERE id = ?`,
      ).run('/repo/.agent-deck/worktrees/legacy', 'session-a');

      const adopted = adoptLegacyExitWithDb(db, {
        sessionId: 'session-a',
        expectedMarker: '/repo/.agent-deck/worktrees/legacy',
        originalCwd: '/repo',
        mainRepo: '/repo',
        worktreePath: '/repo/.agent-deck/worktrees/legacy',
        headCommit: 'a'.repeat(40),
        toolUseId: 'tool-exit',
        continuationKey: 'worktree-cwd:legacy-exit:test-1',
        discardChanges: false,
        requestedAt: 10,
      });

      expect(adopted).toMatchObject({
        generation: 1,
        direction: 'exit',
        phase: 'exit_preflight',
        originalCwd: '/repo',
        targetCwd: '/repo',
        workBranch: '',
        baseBranch: 'HEAD',
      });
      expect(
        db
          .prepare(`SELECT cwd_release_marker FROM sessions WHERE id = ?`)
          .pluck()
          .get('session-a'),
      ).toBe('/repo/.agent-deck/worktrees/legacy');

      const waiting = compareAndSetPhaseWithDb(db, {
          sessionId: 'session-a',
          generation: adopted.generation,
          expected: 'exit_preflight',
          next: 'exit_waiting_tool_result',
          updatedAt: 11,
        });
      expect(waiting.phase).toBe('exit_waiting_tool_result');

      expect(
        releaseLegacyExitAdoptionWithDb(db, {
          sessionId: 'session-a',
          generation: adopted.generation,
          expected: 'exit_waiting_tool_result',
          updatedAt: 12,
          lastError: 'provider result was not observed',
        }),
      ).toMatchObject({
        phase: 'cleared',
        lastError: 'provider result was not observed',
      });
      expect(
        db
          .prepare(`SELECT cwd_release_marker FROM sessions WHERE id = ?`)
          .pluck()
          .get('session-a'),
      ).toBe('/repo/.agent-deck/worktrees/legacy');
    } finally {
      db.close();
    }
  });

  it('refuses legacy adoption when ownership changes after preflight', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      insertSession(db, 'session-a');
      db.prepare(
        `UPDATE sessions SET cwd_release_marker = ? WHERE id = ?`,
      ).run('/repo/.agent-deck/worktrees/new-owner', 'session-a');

      expect(() =>
        adoptLegacyExitWithDb(db, {
          sessionId: 'session-a',
          expectedMarker: '/repo/.agent-deck/worktrees/legacy',
          originalCwd: '/repo',
          mainRepo: '/repo',
          worktreePath: '/repo/.agent-deck/worktrees/legacy',
          headCommit: 'a'.repeat(40),
          toolUseId: 'tool-exit',
          continuationKey: 'cwd-transition:session-a:exit:1',
          discardChanges: false,
          requestedAt: 10,
        }),
      ).toThrow(WorktreeTransitionConflictError);
      expect(
        db
          .prepare(`SELECT COUNT(*) FROM worktree_cwd_transitions`)
          .pluck()
          .get(),
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it('adds a structured record while retaining the legacy marker projection', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      insertSession(db, 'session-a');
      const creating = createEnter(db);
      expect(creating).toMatchObject({
        generation: 1,
        direction: 'enter',
        phase: 'creating',
        toolUseId: 'tool-enter',
        workBranch: '',
        baseBranch: '',
        deleteBranch: false,
      });
      expect(
        db
          .prepare(`SELECT cwd_release_marker FROM sessions WHERE id = ?`)
          .pluck()
          .get('session-a'),
      ).toBeNull();

      const waiting = markEnterCreatedWithDb(
        db,
        'session-a',
        creating.generation,
        11,
      );
      expect(waiting.phase).toBe('enter_waiting_tool_result');
      expect(
        db
          .prepare(`SELECT cwd_release_marker FROM sessions WHERE id = ?`)
          .pluck()
          .get('session-a'),
      ).toBe('/repo/.agent-deck/worktrees/task');
    } finally {
      db.close();
    }
  });

  it('enforces legal compare-and-set phases and rejects stale generations', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      insertSession(db, 'session-a');
      const creating = createEnter(db);

      expect(() =>
        compareAndSetPhaseWithDb(db, {
          sessionId: 'session-a',
          generation: creating.generation,
          expected: 'creating',
          next: 'active',
          updatedAt: 11,
        }),
      ).toThrow('Illegal worktree cwd transition phase');

      expect(() =>
        markEnterCreatedWithDb(db, 'session-a', creating.generation + 1, 11),
      ).toThrow(WorktreeTransitionConflictError);
    } finally {
      db.close();
    }
  });

  it('keeps one active transition, increments generations after clear, and clears the marker', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      insertSession(db, 'session-a');
      const active = advanceToActive(db);
      expect(() => createEnter(db)).toThrow(WorktreeTransitionConflictError);

      beginExitPreflightWithDb(db, 'session-a', active.generation, {
        toolUseId: 'tool-exit',
        continuationKey: 'cwd-transition:session-a:exit:1',
        discardChanges: false,
        requestedAt: 20,
      });
      compareAndSetPhaseWithDb(db, {
        sessionId: 'session-a',
        generation: active.generation,
        expected: 'exit_preflight',
        next: 'exit_waiting_tool_result',
        updatedAt: 21,
      });
      compareAndSetPhaseWithDb(db, {
        sessionId: 'session-a',
        generation: active.generation,
        expected: 'exit_waiting_tool_result',
        next: 'interrupting_exit_turn',
        updatedAt: 22,
      });
      compareAndSetPhaseWithDb(db, {
        sessionId: 'session-a',
        generation: active.generation,
        expected: 'interrupting_exit_turn',
        next: 'restoring_original_cwd',
        updatedAt: 23,
      });
      compareAndSetPhaseWithDb(db, {
        sessionId: 'session-a',
        generation: active.generation,
        expected: 'restoring_original_cwd',
        next: 'cleanup_pending',
        updatedAt: 24,
      });
      compareAndSetPhaseWithDb(db, {
        sessionId: 'session-a',
        generation: active.generation,
        expected: 'cleanup_pending',
        next: 'cleared',
        updatedAt: 25,
      });
      expect(
        db
          .prepare(`SELECT cwd_release_marker FROM sessions WHERE id = ?`)
          .pluck()
          .get('session-a'),
      ).toBeNull();

      const second = createEnter(db);
      expect(second.generation).toBe(2);
    } finally {
      db.close();
    }
  });

  it('delivers the fixed continuation once and transfers only a settled active lease', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      insertSession(db, 'session-a');
      insertSession(db, 'session-b', '/repo/.agent-deck/worktrees/task');
      const active = advanceToActive(db);
      expect(
        markContinuationDeliveredWithDb(
          db,
          'session-a',
          active.generation,
          active.continuationKey,
          15,
        ),
      ).toBe(true);
      expect(
        markContinuationDeliveredWithDb(
          db,
          'session-a',
          active.generation,
          active.continuationKey,
          16,
        ),
      ).toBe(false);

      const transferred = transferActiveLeaseWithDb(
        db,
        'session-a',
        'session-b',
        17,
      );
      expect(transferred).toMatchObject({
        sessionId: 'session-b',
        phase: 'active',
        generation: active.generation,
      });
      expect(
        db
          .prepare(`SELECT cwd, cwd_release_marker FROM sessions WHERE id = ?`)
          .get('session-a'),
      ).toEqual({
        cwd: '/repo',
        cwd_release_marker: null,
      });
      expect(
        db
          .prepare(`SELECT cwd, cwd_release_marker FROM sessions WHERE id = ?`)
          .get('session-b'),
      ).toEqual({
        cwd: '/repo/.agent-deck/worktrees/task',
        cwd_release_marker: '/repo/.agent-deck/worktrees/task',
      });
    } finally {
      db.close();
    }
  });

  it('persists buffered input in FIFO order and transfers it with an active lease', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      insertSession(db, 'session-a');
      insertSession(db, 'session-b', '/repo/.agent-deck/worktrees/task');
      const creating = createEnter(db);
      markEnterCreatedWithDb(db, 'session-a', creating.generation, 11);
      appendWorktreeTransitionInputWithDb(db, {
        sessionId: 'session-a',
        generation: creating.generation,
        agentId: 'codex-cli',
        text: 'first',
        attachments: [{ path: '/tmp/one.png' }],
        createdAt: 12,
      });
      appendWorktreeTransitionInputWithDb(db, {
        sessionId: 'session-a',
        generation: creating.generation,
        agentId: 'codex-cli',
        text: 'second',
        createdAt: 13,
      });
      expect(
        listPendingWorktreeTransitionInputsWithDb(
          db,
          'session-a',
          creating.generation,
        ).map((input) => [input.sequence, input.text, input.attachments]),
      ).toEqual([
        [1, 'first', [{ path: '/tmp/one.png' }]],
        [2, 'second', []],
      ]);
      expect(
        markWorktreeTransitionInputDeliveredWithDb(
          db,
          'session-a',
          creating.generation,
          1,
          14,
        ),
      ).toBe(true);

      compareAndSetPhaseWithDb(db, {
        sessionId: 'session-a',
        generation: creating.generation,
        expected: 'enter_waiting_tool_result',
        next: 'interrupting_enter_turn',
        updatedAt: 15,
      });
      compareAndSetPhaseWithDb(db, {
        sessionId: 'session-a',
        generation: creating.generation,
        expected: 'interrupting_enter_turn',
        next: 'switching_to_worktree',
        updatedAt: 16,
      });
      compareAndSetPhaseWithDb(db, {
        sessionId: 'session-a',
        generation: creating.generation,
        expected: 'switching_to_worktree',
        next: 'active',
        updatedAt: 17,
      });
      transferActiveLeaseWithDb(
        db,
        'session-a',
        'session-b',
        18,
      );
      expect(
        listPendingWorktreeTransitionInputsWithDb(
          db,
          'session-b',
          creating.generation,
        ).map((input) => input.text),
      ).toEqual(['second']);
    } finally {
      db.close();
    }
  });

  it('restores enter direction and worktree target when an unacknowledged exit is aborted', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      insertSession(db, 'session-a');
      const active = advanceToActive(db);
      beginExitPreflightWithDb(db, 'session-a', active.generation, {
        toolUseId: 'tool-exit',
        continuationKey: 'cwd-transition:session-a:exit:1',
        discardChanges: false,
        requestedAt: 20,
      });
      const restored = compareAndSetPhaseWithDb(db, {
        sessionId: 'session-a',
        generation: active.generation,
        expected: 'exit_preflight',
        next: 'active',
        updatedAt: 21,
      });
      expect(restored).toMatchObject({
        direction: 'enter',
        phase: 'active',
        targetCwd: '/repo/.agent-deck/worktrees/task',
      });
    } finally {
      db.close();
    }
  });

  it('drops stale cleared-target inputs when a session rename moves an active lease', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      insertSession(db, 'session-a');
      insertSession(db, 'session-b');
      const source = createEnter(db, 'session-a');
      markEnterCreatedWithDb(db, 'session-a', source.generation, 11);
      appendWorktreeTransitionInputWithDb(db, {
        sessionId: 'session-a',
        generation: source.generation,
        agentId: 'codex-cli',
        text: 'source input',
        createdAt: 12,
      });
      compareAndSetPhaseWithDb(db, {
        sessionId: 'session-a',
        generation: source.generation,
        expected: 'enter_waiting_tool_result',
        next: 'interrupting_enter_turn',
        updatedAt: 13,
      });
      compareAndSetPhaseWithDb(db, {
        sessionId: 'session-a',
        generation: source.generation,
        expected: 'interrupting_enter_turn',
        next: 'switching_to_worktree',
        updatedAt: 14,
      });
      compareAndSetPhaseWithDb(db, {
        sessionId: 'session-a',
        generation: source.generation,
        expected: 'switching_to_worktree',
        next: 'active',
        updatedAt: 15,
      });

      const staleTarget = createEnter(db, 'session-b');
      appendWorktreeTransitionInputWithDb(db, {
        sessionId: 'session-b',
        generation: staleTarget.generation,
        agentId: 'codex-cli',
        text: 'stale target input',
        createdAt: 16,
      });
      compareAndSetPhaseWithDb(db, {
        sessionId: 'session-b',
        generation: staleTarget.generation,
        expected: 'creating',
        next: 'cleared',
        updatedAt: 17,
      });

      renameLeaseWithDb(db, 'session-a', 'session-b', 18);
      expect(
        listPendingWorktreeTransitionInputsWithDb(
          db,
          'session-b',
          source.generation,
        ).map((input) => input.text),
      ).toEqual(['source input']);
    } finally {
      db.close();
    }
  });
});
