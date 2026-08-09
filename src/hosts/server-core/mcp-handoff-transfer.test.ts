import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
import { createAgentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import {
  bindingAvailable,
  insertSession,
  makeMemoryDb,
} from '@main/store/__tests__/agent-deck-repos/_setup';
import {
  compareAndSetPhaseWithDb,
  createEnterWithDb,
  markEnterCreatedWithDb,
} from '@main/store/worktree-transition-repo';
import { getWorktreeTransitionWithDb } from '@main/store/worktree-transition-row';

import { transferServerCoreHandOffResources } from './mcp-handoff-transfer';
import type { ServerCoreMcpPresentationPort } from './mcp-presentation-port';
import type { ServerCoreWorktreeRuntimePort } from './mcp-worktree-port';

const databases: Database.Database[] = [];

function addTask(
  database: Database.Database,
  id: string,
  owner: string,
  teamId: string | null,
): void {
  database.prepare(
    `INSERT INTO tasks
      (id, owner_session_id, team_id, subject, status, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 5, ?, ?)`,
  ).run(id, owner, teamId, `task-${id}`, '2026-08-07T00:00:00.000Z', '2026-08-07T00:00:00.000Z');
}

function activateWorktree(database: Database.Database, sourceId: string): void {
  const created = createEnterWithDb(database, {
    sessionId: sourceId,
    originalCwd: '/Workspace/project-a',
    targetCwd: '/Workspace/.agent-deck/worktrees/task-a',
    mainRepo: '/Workspace/project-a',
    worktreePath: '/Workspace/.agent-deck/worktrees/task-a',
    baseCommit: 'a'.repeat(40),
    toolUseId: 'tool-enter',
    continuationKey: 'worktree:enter:a',
    requestedAt: 10,
  });
  markEnterCreatedWithDb(database, sourceId, created.generation, 11);
  const steps = [
    ['enter_waiting_tool_result', 'interrupting_enter_turn'],
    ['interrupting_enter_turn', 'switching_to_worktree'],
    ['switching_to_worktree', 'active'],
  ] as const;
  for (const [index, [expected, next]] of steps.entries()) {
    compareAndSetPhaseWithDb(database, {
      sessionId: sourceId,
      generation: created.generation,
      expected,
      next,
      updatedAt: 12 + index,
    });
  }
}

function harness(input: { activeWorktree?: boolean; successorCwd?: string } = {}) {
  const database = makeMemoryDb();
  databases.push(database);
  insertSession(database, 'source', 'codex-cli');
  insertSession(database, 'successor', 'codex-cli');
  insertSession(database, 'peer', 'claude-code');
  const teams = createAgentDeckTeamRepo(database);
  const team = teams.create({ name: 'handoff-team' });
  teams.addMember({ teamId: team.id, sessionId: 'source', role: 'lead' });
  teams.addMember({ teamId: team.id, sessionId: 'peer', role: 'teammate' });
  addTask(database, 'task-personal', 'source', null);
  addTask(database, 'task-team', 'source', team.id);
  const messages = createAgentDeckMessageRepo(database);
  const pending = messages.insert({
    teamId: null,
    fromSessionId: 'peer',
    toSessionId: 'source',
    body: 'pending for the logical owner',
    replyToMessageId: null,
  });
  if (input.activeWorktree) activateWorktree(database, 'source');
  const renameSession = vi.fn();
  const transferSession = vi.fn();
  const notifyMembershipChanged = vi.fn();
  const appendChange = vi.fn();
  const warn = vi.fn();
  const result = () => transferServerCoreHandOffResources('source', 'successor', {
    database,
    successorCwd: input.successorCwd ?? (input.activeWorktree
      ? '/Workspace/.agent-deck/worktrees/task-a'
      : '/Workspace/project-a'),
    worktrees: { renameSession } as unknown as ServerCoreWorktreeRuntimePort,
    presentations: { transferSession } as unknown as ServerCoreMcpPresentationPort,
    notifyMembershipChanged,
    appendChange,
    warn,
    now: () => 20,
  });
  return {
    appendChange,
    database,
    messages,
    notifyMembershipChanged,
    pending,
    renameSession,
    result,
    team,
    teams,
    transferSession,
    warn,
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe.skipIf(!bindingAvailable)('transferServerCoreHandOffResources', () => {
  it('moves tasks, teams, message endpoints, aliases, and an active worktree in one commit', () => {
    const state = harness({ activeWorktree: true });
    const result = state.result();

    expect(result).toMatchObject({
      tasks: { status: 'ok', count: 2 },
      teams: {
        status: 'ok',
        transferred: [{ teamId: state.team.id, role: 'lead' }],
      },
      worktreeLease: {
        status: 'ok',
        worktreePath: '/Workspace/.agent-deck/worktrees/task-a',
      },
    });
    expect(state.database.prepare(
      `SELECT DISTINCT owner_session_id FROM tasks ORDER BY owner_session_id`,
    ).pluck().all()).toEqual(['successor']);
    expect(state.teams.findActiveMembershipIn(state.team.id, 'source')).toBeNull();
    expect(state.teams.findActiveMembershipIn(state.team.id, 'successor')?.role).toBe('lead');
    expect(state.messages.get(state.pending.id)).toMatchObject({
      fromSessionId: 'peer',
      toSessionId: 'successor',
      status: 'pending',
    });
    expect(state.database.prepare(
      `SELECT successor_session_id FROM session_handoff_aliases WHERE source_session_id = 'source'`,
    ).pluck().get()).toBe('successor');
    expect(getWorktreeTransitionWithDb(state.database, 'source')).toBeNull();
    expect(getWorktreeTransitionWithDb(state.database, 'successor')?.phase).toBe('active');
    expect(state.transferSession).toHaveBeenCalledWith('source', 'successor');
    expect(state.renameSession).toHaveBeenCalledWith('source', 'successor');
    expect(state.notifyMembershipChanged).toHaveBeenCalledTimes(2);
    expect(state.appendChange).toHaveBeenCalledWith(
      'session.handoff.resources',
      'successor',
      expect.objectContaining({ taskCount: 2, teamCount: 1, worktreeTransferred: true }),
    );
  });

  it('rolls back every durable owner when the worktree transition is not settled', () => {
    const state = harness();
    createEnterWithDb(state.database, {
      sessionId: 'source',
      originalCwd: '/Workspace/project-a',
      targetCwd: '/Workspace/.agent-deck/worktrees/task-a',
      mainRepo: '/Workspace/project-a',
      worktreePath: '/Workspace/.agent-deck/worktrees/task-a',
      baseCommit: 'a'.repeat(40),
      toolUseId: 'tool-enter',
      continuationKey: 'worktree:enter:a',
      requestedAt: 10,
    });

    expect(state.result).toThrow(/pending/);
    expect(state.database.prepare(
      `SELECT DISTINCT owner_session_id FROM tasks`,
    ).pluck().all()).toEqual(['source']);
    expect(state.teams.findActiveMembershipIn(state.team.id, 'source')?.role).toBe('lead');
    expect(state.teams.findActiveMembershipIn(state.team.id, 'successor')).toBeNull();
    expect(state.messages.get(state.pending.id)?.toSessionId).toBe('source');
    expect(state.database.prepare(
      `SELECT count(*) FROM session_handoff_aliases`,
    ).pluck().get()).toBe(0);
    expect(state.transferSession).not.toHaveBeenCalled();
    expect(state.renameSession).not.toHaveBeenCalled();
  });

  it('rolls back every durable owner when successor cwd conflicts with an active lease', () => {
    const state = harness({
      activeWorktree: true,
      successorCwd: '/Workspace/project-b',
    });

    expect(state.result).toThrow(/Successor cwd/);
    expect(state.database.prepare(
      `SELECT DISTINCT owner_session_id FROM tasks`,
    ).pluck().all()).toEqual(['source']);
    expect(state.teams.findActiveMembershipIn(state.team.id, 'source')?.role).toBe('lead');
    expect(state.teams.findActiveMembershipIn(state.team.id, 'successor')).toBeNull();
    expect(getWorktreeTransitionWithDb(state.database, 'source')?.phase).toBe('active');
    expect(getWorktreeTransitionWithDb(state.database, 'successor')).toBeNull();
    expect(state.transferSession).not.toHaveBeenCalled();
    expect(state.renameSession).not.toHaveBeenCalled();
  });
});
