import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { CURRENT_SCHEMA_SQL } from '../schema';
import {
  findSessionHandOffSuccessorWithDb,
  recordSessionHandOffAliasWithDb,
} from '../session-handoff-alias-repo';
import {
  beginExitPreflightWithDb,
  compareAndSetPhaseWithDb,
  createEnterWithDb,
  markContinuationDeliveredWithDb,
  markEnterCreatedWithDb,
} from '../worktree-transition-repo';
import {
  appendWorktreeTransitionInputWithDb,
  markWorktreeTransitionInputDeliveredWithDb,
  WorktreeTransitionInputClosedError,
} from '../worktree-transition-input-repo';
import {
  sealWorktreeTransitionInputAfterDrainWithDb,
  settleWorktreeTransitionAfterInputDrainWithDb,
} from '../worktree-transition-drain-repo';
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
    currentDb.exec(CURRENT_SCHEMA_SQL);
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
      baseCommit: 'a'.repeat(40),
      toolUseId: 'tool-enter',
      continuationKey: 'cwd:test:1',
      requestedAt: 10,
    });
    markEnterCreatedWithDb(currentDb!, 'session-a', creating.generation, 11);

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
  });

  it('allows history deletion only after the lease is cleared', () => {
    insertClosedSession('session-a');
    const creating = createEnterWithDb(currentDb!, {
      sessionId: 'session-a',
      originalCwd: '/repo',
      targetCwd: '/repo/.agent-deck/worktrees/task',
      mainRepo: '/repo',
      worktreePath: '/repo/.agent-deck/worktrees/task',
      baseCommit: 'a'.repeat(40),
      toolUseId: 'tool-enter',
      continuationKey: 'cwd:test:1',
      requestedAt: 10,
    });
    markEnterCreatedWithDb(currentDb!, 'session-a', creating.generation, 11);
    const input = appendWorktreeTransitionInputWithDb(currentDb!, {
      sessionId: 'session-a',
      generation: creating.generation,
      agentId: 'codex-cli',
      text: 'settled input',
      createdAt: 11,
    });
    markWorktreeTransitionInputDeliveredWithDb(
      currentDb!,
      'session-a',
      creating.generation,
      input.sequence,
      12,
    );
    settleWorktreeTransitionAfterInputDrainWithDb(currentDb!, {
      sessionId: 'session-a',
      generation: creating.generation,
      expected: 'enter_waiting_tool_result',
      next: 'cleared',
      updatedAt: 13,
    });

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

  it('removes durable handoff aliases when deleted session ids can be reused', () => {
    insertClosedSession('direct-source');
    insertClosedSession('direct-successor');
    insertClosedSession('direct-predecessor');
    recordSessionHandOffAliasWithDb(currentDb!, 'direct-source', 'direct-successor', 10);
    recordSessionHandOffAliasWithDb(currentDb!, 'direct-predecessor', 'direct-source', 11);

    deleteSession('direct-source');

    expect(findSessionHandOffSuccessorWithDb(currentDb!, 'direct-source')).toBeNull();
    expect(findSessionHandOffSuccessorWithDb(currentDb!, 'direct-predecessor')).toBeNull();

    insertClosedSession('history-source');
    insertClosedSession('history-successor');
    recordSessionHandOffAliasWithDb(currentDb!, 'history-source', 'history-successor', 12);
    expect(
      batchDeleteHistory(
        [{ id: 'history-source', cliSessionId: null, lastEventAt: 1 }],
        100,
      ).map((row) => row.id),
    ).toEqual(['history-source']);
    expect(findSessionHandOffSuccessorWithDb(currentDb!, 'history-source')).toBeNull();
  });

  it('atomically drains late inputs before sealing an acknowledged enter', () => {
    insertClosedSession('session-a');
    const created = createEnterWithDb(currentDb!, {
      sessionId: 'session-a',
      originalCwd: '/repo',
      targetCwd: '/repo/.agent-deck/worktrees/task',
      mainRepo: '/repo',
      worktreePath: '/repo/.agent-deck/worktrees/task',
      baseCommit: 'a'.repeat(40),
      toolUseId: 'tool-enter',
      continuationKey: 'cwd:test:enter',
      requestedAt: 10,
    });
    markEnterCreatedWithDb(currentDb!, 'session-a', created.generation, 11);
    compareAndSetPhaseWithDb(currentDb!, {
      sessionId: 'session-a',
      generation: created.generation,
      expected: 'enter_waiting_tool_result',
      next: 'interrupting_enter_turn',
      updatedAt: 12,
    });
    compareAndSetPhaseWithDb(currentDb!, {
      sessionId: 'session-a',
      generation: created.generation,
      expected: 'interrupting_enter_turn',
      next: 'switching_to_worktree',
      updatedAt: 13,
    });
    markContinuationDeliveredWithDb(
      currentDb!,
      'session-a',
      created.generation,
      'cwd:test:enter',
      14,
    );
    const first = appendWorktreeTransitionInputWithDb(currentDb!, {
      sessionId: 'session-a',
      generation: created.generation,
      agentId: 'codex-cli',
      text: 'first',
      createdAt: 15,
    });
    markWorktreeTransitionInputDeliveredWithDb(
      currentDb!,
      'session-a',
      created.generation,
      first.sequence,
      16,
    );
    const late = appendWorktreeTransitionInputWithDb(currentDb!, {
      sessionId: 'session-a',
      generation: created.generation,
      agentId: 'codex-cli',
      text: 'late',
      createdAt: 17,
    });

    expect(settleWorktreeTransitionAfterInputDrainWithDb(currentDb!, {
      sessionId: 'session-a',
      generation: created.generation,
      expected: 'switching_to_worktree',
      next: 'active',
      updatedAt: 18,
    })).toMatchObject({ settled: false });

    markWorktreeTransitionInputDeliveredWithDb(
      currentDb!,
      'session-a',
      created.generation,
      late.sequence,
      19,
    );
    const settled = settleWorktreeTransitionAfterInputDrainWithDb(currentDb!, {
      sessionId: 'session-a',
      generation: created.generation,
      expected: 'switching_to_worktree',
      next: 'active',
      updatedAt: 20,
    });
    expect(settled).toMatchObject({
      settled: true,
      record: { phase: 'active', toolUseId: null },
    });
    expect(() => appendWorktreeTransitionInputWithDb(currentDb!, {
      sessionId: 'session-a',
      generation: created.generation,
      agentId: 'codex-cli',
      text: 'post-seal',
      createdAt: 21,
    })).toThrow(WorktreeTransitionInputClosedError);
  });

  it('can seal a failed enter at the original cwd without a success continuation', () => {
    insertClosedSession('session-a');
    const created = createEnterWithDb(currentDb!, {
      sessionId: 'session-a',
      originalCwd: '/repo',
      targetCwd: '/repo/.agent-deck/worktrees/task',
      mainRepo: '/repo',
      worktreePath: '/repo/.agent-deck/worktrees/task',
      baseCommit: 'a'.repeat(40),
      toolUseId: 'tool-enter',
      continuationKey: 'cwd:test:rollback',
      requestedAt: 10,
    });
    markEnterCreatedWithDb(currentDb!, 'session-a', created.generation, 11);
    compareAndSetPhaseWithDb(currentDb!, {
      sessionId: 'session-a',
      generation: created.generation,
      expected: 'enter_waiting_tool_result',
      next: 'interrupting_enter_turn',
      updatedAt: 12,
    });
    compareAndSetPhaseWithDb(currentDb!, {
      sessionId: 'session-a',
      generation: created.generation,
      expected: 'interrupting_enter_turn',
      next: 'switching_to_worktree',
      updatedAt: 13,
    });

    expect(settleWorktreeTransitionAfterInputDrainWithDb(currentDb!, {
      sessionId: 'session-a',
      generation: created.generation,
      expected: 'switching_to_worktree',
      next: 'cleared',
      updatedAt: 14,
      lastError: 'target switch failed',
    })).toMatchObject({
      settled: true,
      record: {
        phase: 'cleared',
        toolUseId: null,
        continuationDelivered: false,
      },
    });
  });

  it('keeps cleanup authority while atomically sealing failed-exit ingress', () => {
    insertClosedSession('session-a');
    const created = createEnterWithDb(currentDb!, {
      sessionId: 'session-a',
      originalCwd: '/repo',
      targetCwd: '/repo/.agent-deck/worktrees/task',
      mainRepo: '/repo',
      worktreePath: '/repo/.agent-deck/worktrees/task',
      baseCommit: 'a'.repeat(40),
      toolUseId: 'tool-enter',
      continuationKey: 'cwd:test:enter',
      requestedAt: 10,
    });
    markEnterCreatedWithDb(currentDb!, 'session-a', created.generation, 11);
    compareAndSetPhaseWithDb(currentDb!, {
      sessionId: 'session-a',
      generation: created.generation,
      expected: 'enter_waiting_tool_result',
      next: 'interrupting_enter_turn',
      updatedAt: 12,
    });
    compareAndSetPhaseWithDb(currentDb!, {
      sessionId: 'session-a',
      generation: created.generation,
      expected: 'interrupting_enter_turn',
      next: 'switching_to_worktree',
      updatedAt: 13,
    });
    markContinuationDeliveredWithDb(
      currentDb!,
      'session-a',
      created.generation,
      'cwd:test:enter',
      14,
    );
    settleWorktreeTransitionAfterInputDrainWithDb(currentDb!, {
      sessionId: 'session-a',
      generation: created.generation,
      expected: 'switching_to_worktree',
      next: 'active',
      updatedAt: 15,
    });
    beginExitPreflightWithDb(currentDb!, 'session-a', created.generation, {
      toolUseId: 'tool-exit',
      continuationKey: 'cwd:test:exit',
      discardChanges: false,
      requestedAt: 16,
    });
    for (const [expected, next, updatedAt] of [
      ['exit_preflight', 'exit_waiting_tool_result', 17],
      ['exit_waiting_tool_result', 'interrupting_exit_turn', 18],
      ['interrupting_exit_turn', 'restoring_original_cwd', 19],
      ['restoring_original_cwd', 'cleanup_pending', 20],
    ] as const) {
      compareAndSetPhaseWithDb(currentDb!, {
        sessionId: 'session-a',
        generation: created.generation,
        expected,
        next,
        updatedAt,
      });
    }
    markContinuationDeliveredWithDb(
      currentDb!,
      'session-a',
      created.generation,
      'cwd:test:exit',
      21,
    );
    const pending = appendWorktreeTransitionInputWithDb(currentDb!, {
      sessionId: 'session-a',
      generation: created.generation,
      agentId: 'codex-cli',
      text: 'during cleanup',
      createdAt: 22,
    });
    expect(sealWorktreeTransitionInputAfterDrainWithDb(currentDb!, {
      sessionId: 'session-a',
      generation: created.generation,
      expected: 'cleanup_pending',
      updatedAt: 23,
      lastError: 'cleanup failed',
    })).toMatchObject({ settled: false });
    markWorktreeTransitionInputDeliveredWithDb(
      currentDb!,
      'session-a',
      created.generation,
      pending.sequence,
      24,
    );
    expect(sealWorktreeTransitionInputAfterDrainWithDb(currentDb!, {
      sessionId: 'session-a',
      generation: created.generation,
      expected: 'cleanup_pending',
      updatedAt: 25,
      lastError: 'cleanup failed',
    })).toMatchObject({
      settled: true,
      record: {
        phase: 'cleanup_pending',
        toolUseId: null,
        lastError: 'cleanup failed',
      },
    });
  });
});
