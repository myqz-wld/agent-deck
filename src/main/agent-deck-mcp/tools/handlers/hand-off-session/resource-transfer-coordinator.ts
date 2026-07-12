import { eventBus } from '@main/event-bus';
import { sessionManager } from '@main/session/manager';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { getDb } from '@main/store/db';
import { sessionRepo } from '@main/store/session-repo';
import { taskRepo } from '@main/store/task-repo';
import {
  compressSessionHandOffAliasesWithDb,
  recordSessionHandOffAliasWithDb,
} from '@main/store/session-handoff-alias-repo';
import log from '@main/utils/logger';
import type { SessionRecord } from '@shared/types';
import type { HandOffSessionResult } from '../../schemas';

const logger = log.scope('mcp-handoff-transfer');

export type HandOffResourceTransferResult = HandOffSessionResult['resourceTransfer'];

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function safeNotifyMembership(sessionId: string): void {
  try {
    sessionManager.notifyTeamMembershipChanged(sessionId);
  } catch (e) {
    logger.warn(`[mcp hand_off_session] notifyTeamMembershipChanged(${sessionId}) failed:`, e);
  }
}

function safeEmitTeamMemberChanged(
  teamId: string,
  sessionId: string,
  kind: 'joined' | 'left',
): void {
  try {
    eventBus.emit('agent-deck-team-member-changed', { teamId, sessionId, kind });
  } catch (e) {
    logger.warn(
      `[mcp hand_off_session] emit agent-deck-team-member-changed(${teamId}, ${sessionId}, ${kind}) failed:`,
      e,
    );
  }
}

function transferWorktreeMarker(
  callerRow: SessionRecord,
  newSessionId: string,
): HandOffResourceTransferResult['worktreeMarker'] {
  const marker = callerRow.cwdReleaseMarker ?? null;
  if (!marker) return { status: 'skipped', marker: null };
  try {
    sessionRepo.setCwdReleaseMarker(newSessionId, marker);
    return { status: 'ok', marker };
  } catch (e) {
    return { status: 'failed', marker, error: errorMessage(e) };
  }
}

function rollbackWorktreeMarker(
  result: HandOffResourceTransferResult['worktreeMarker'],
  newSessionId: string,
): HandOffResourceTransferResult['worktreeMarker'] {
  if (result.status !== 'ok') return result;
  try {
    sessionRepo.setCwdReleaseMarker(newSessionId, null);
    return { status: 'skipped', marker: result.marker };
  } catch (e) {
    return {
      status: 'failed',
      marker: result.marker,
      error: `rollback-failed: ${errorMessage(e)}`,
    };
  }
}

function skippedTeams(reason: string): HandOffResourceTransferResult['teams'] {
  return {
    status: 'failed',
    transferred: [],
    skipped: [],
    failed: [{ teamId: '*', role: 'teammate', reason }],
  };
}

function failedTasks(reason: string): HandOffResourceTransferResult['tasks'] {
  return { status: 'failed', count: 0, error: reason };
}

function transferTeams(
  callerSessionId: string,
  newSessionId: string,
  postCommitEvents: Array<() => void>,
): HandOffResourceTransferResult['teams'] {
  const transferred: HandOffResourceTransferResult['teams']['transferred'] = [];
  const skipped: HandOffResourceTransferResult['teams']['skipped'] = [];
  const failed: HandOffResourceTransferResult['teams']['failed'] = [];
  const rollback: Array<() => void> = [];

  let memberships: ReturnType<typeof agentDeckTeamRepo.findActiveMembershipsBySession>;
  let candidates: Array<{ teamId: string; role: 'lead' | 'teammate' }>;
  try {
    memberships = agentDeckTeamRepo.findActiveMembershipsBySession(callerSessionId);
  } catch (e) {
    return {
      status: 'failed',
      transferred,
      skipped,
      failed: [
        {
          teamId: '*',
          role: 'teammate',
          reason: `list-memberships-failed: ${errorMessage(e)}`,
        },
      ],
    };
  }

  try {
    candidates = agentDeckTeamRepo
      .findActiveTeamMembershipsBySession(callerSessionId)
      .map((m) => ({ teamId: m.teamId, role: m.role }));
  } catch (e) {
    return {
      status: 'failed',
      transferred,
      skipped,
      failed: [
        {
          teamId: '*',
          role: 'teammate',
          reason: `list-active-team-memberships-failed: ${errorMessage(e)}`,
        },
      ],
    };
  }

  const candidateTeamIds = new Set(candidates.map((m) => m.teamId));
  for (const m of memberships) {
    if (candidateTeamIds.has(m.teamId)) continue;
    const role = m.role;
    try {
      const team = agentDeckTeamRepo.get(m.teamId);
      if (!team) {
        failed.push({ teamId: m.teamId, role, reason: 'team-not-found' });
        continue;
      }
      if (team.archivedAt !== null) {
        skipped.push({ teamId: m.teamId, role, reason: 'team-archived' });
        continue;
      }
      failed.push({ teamId: m.teamId, role, reason: 'active-team-query-mismatch' });
    } catch (e) {
      failed.push({ teamId: m.teamId, role, reason: errorMessage(e) });
    }
  }

  if (failed.length > 0) {
    return {
      status: 'failed',
      transferred,
      skipped,
      failed,
    };
  }

  for (const m of candidates) {
    const role = m.role;
    try {
      if (role === 'lead') {
        const swapped = agentDeckTeamRepo.swapLead(m.teamId, callerSessionId, newSessionId);
        if (swapped.swapped !== true) {
          failed.push({ teamId: m.teamId, role, reason: swapped.reason });
          break;
        }
        transferred.push({ teamId: m.teamId, role });
        rollback.push(() => {
          const rolledBack = agentDeckTeamRepo.swapLead(m.teamId, newSessionId, callerSessionId);
          if (rolledBack.swapped !== true) {
            throw new Error(rolledBack.reason);
          }
        });
        postCommitEvents.push(() => {
          safeEmitTeamMemberChanged(m.teamId, callerSessionId, 'left');
          safeEmitTeamMemberChanged(m.teamId, newSessionId, 'joined');
          safeNotifyMembership(callerSessionId);
          safeNotifyMembership(newSessionId);
        });
        continue;
      }

      const existingBefore = agentDeckTeamRepo.findActiveMembershipIn(m.teamId, newSessionId);
      try {
        agentDeckTeamRepo.addMember({
          teamId: m.teamId,
          sessionId: newSessionId,
          role: 'teammate',
        });
      } catch (e) {
        const existing = agentDeckTeamRepo.findActiveMembershipIn(m.teamId, newSessionId);
        if (!existing) throw e;
      }
      transferred.push({ teamId: m.teamId, role });
      if (!existingBefore) {
        rollback.push(() => {
          agentDeckTeamRepo.leaveTeam(m.teamId, newSessionId);
        });
      }
      postCommitEvents.push(() => {
        safeEmitTeamMemberChanged(m.teamId, newSessionId, 'joined');
        safeNotifyMembership(newSessionId);
      });
    } catch (e) {
      failed.push({ teamId: m.teamId, role, reason: errorMessage(e) });
      break;
    }
  }

  if (failed.length > 0) {
    for (const undo of rollback.reverse()) {
      try {
        undo();
      } catch (e) {
        failed.push({
          teamId: '*',
          role: 'teammate',
          reason: `rollback-failed: ${errorMessage(e)}`,
        });
      }
    }
    return {
      status: 'failed',
      transferred: [],
      skipped,
      failed,
    };
  }

  return {
    status: 'ok',
    transferred,
    skipped,
    failed,
  };
}

class ResourceTransferAborted extends Error {
  constructor(readonly result: HandOffResourceTransferResult) {
    super('handoff resource transfer rolled back');
    this.name = 'ResourceTransferAborted';
  }
}

function transferFailed(result: HandOffResourceTransferResult): boolean {
  return (
    result.tasks.status === 'failed' ||
    result.teams.status === 'failed' ||
    result.worktreeMarker.status === 'failed'
  );
}

function transferTasks(
  callerSessionId: string,
  newSessionId: string,
): HandOffResourceTransferResult['tasks'] {
  try {
    const count = taskRepo.reassignOwner(callerSessionId, newSessionId, {
      policy: 'preserve-team',
    });
    return { status: 'ok', count };
  } catch (e) {
    return { status: 'failed', count: 0, error: errorMessage(e) };
  }
}

/** Keep queued inbound and outbound envelopes attached to the new owner. */
function retargetInFlightMessages(callerSessionId: string, newSessionId: string): void {
  getDb()
    .prepare(
      `UPDATE agent_deck_messages
          SET from_session_id = CASE WHEN from_session_id = ? THEN ? ELSE from_session_id END,
              to_session_id = CASE WHEN to_session_id = ? THEN ? ELSE to_session_id END
        WHERE (from_session_id = ? OR to_session_id = ?)
          AND status IN ('pending', 'delivering')`,
    )
    .run(
      callerSessionId,
      newSessionId,
      callerSessionId,
      newSessionId,
      callerSessionId,
      callerSessionId,
    );
}

/** Flatten every older wire anchor that currently resolves to the outgoing owner. */
function compressHandOffAliases(callerSessionId: string, newSessionId: string): void {
  compressSessionHandOffAliasesWithDb(getDb(), callerSessionId, newSessionId);
}

function rollbackTasks(
  result: HandOffResourceTransferResult['tasks'],
  callerSessionId: string,
  newSessionId: string,
  reason: string,
): HandOffResourceTransferResult['tasks'] {
  if (result.status !== 'ok' || result.count === 0) return failedTasks(reason);
  try {
    taskRepo.reassignOwner(newSessionId, callerSessionId, {
      policy: 'preserve-team',
    });
    return failedTasks(reason);
  } catch (e) {
    return {
      status: 'failed',
      count: result.count,
      error: `rollback-failed after ${reason}: ${errorMessage(e)}`,
    };
  }
}

function transferHandOffResourcesInTransaction(input: {
  callerSessionId: string;
  callerRow: SessionRecord;
  newSessionId: string;
}, postCommitEvents: Array<() => void>): HandOffResourceTransferResult {
  const marker = transferWorktreeMarker(input.callerRow, input.newSessionId);
  if (marker.status === 'failed') {
    return {
      teams: skippedTeams('skipped team transfer because worktree marker transfer failed'),
      tasks: failedTasks('skipped task transfer because worktree marker transfer failed'),
      worktreeMarker: marker,
    };
  }

  const tasks = transferTasks(input.callerSessionId, input.newSessionId);
  if (tasks.status === 'failed') {
    const rolledBackMarker = rollbackWorktreeMarker(marker, input.newSessionId);
    return {
      teams: skippedTeams('skipped team transfer because task transfer failed'),
      tasks,
      worktreeMarker: rolledBackMarker,
    };
  }

  const teams = transferTeams(input.callerSessionId, input.newSessionId, postCommitEvents);
  if (teams.status === 'failed') {
    const rolledBackTasks = rollbackTasks(
      tasks,
      input.callerSessionId,
      input.newSessionId,
      'team transfer failed',
    );
    const rolledBackMarker = rollbackWorktreeMarker(marker, input.newSessionId);
    return { tasks: rolledBackTasks, teams, worktreeMarker: rolledBackMarker };
  }

  retargetInFlightMessages(input.callerSessionId, input.newSessionId);
  compressHandOffAliases(input.callerSessionId, input.newSessionId);
  recordSessionHandOffAliasWithDb(
    getDb(),
    input.callerSessionId,
    input.newSessionId,
  );

  return { tasks, teams, worktreeMarker: marker };
}

export function transferHandOffResources(input: {
  callerSessionId: string;
  callerRow: SessionRecord;
  newSessionId: string;
}): HandOffResourceTransferResult {
  const postCommitEvents: Array<() => void> = [];
  const tx = getDb().transaction(() => {
    const result = transferHandOffResourcesInTransaction(input, postCommitEvents);
    // A returned failure is still a transaction failure: throw a private sentinel so SQLite rolls
    // back marker, task, and team writes even when one of the best-effort compensations also failed.
    if (transferFailed(result)) throw new ResourceTransferAborted(result);
    return result;
  });

  let result: HandOffResourceTransferResult;
  try {
    result = tx();
  } catch (error) {
    if (error instanceof ResourceTransferAborted) return error.result;
    throw error;
  }

  // Renderer/team notifications must observe committed durable ownership, never an intermediate
  // state that may still roll back because a later transfer step or COMMIT failed.
  for (const emitEvent of postCommitEvents) emitEvent();
  return result;
}
