import { eventBus } from '@main/event-bus';
import { sessionManager } from '@main/session/manager';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { sessionRepo } from '@main/store/session-repo';
import { taskRepo } from '@main/store/task-repo';
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
    failed: [{ teamId: '*', role: 'teammate', reason }],
  };
}

function failedTasks(reason: string): HandOffResourceTransferResult['tasks'] {
  return { status: 'failed', count: 0, error: reason };
}

function transferTeams(
  callerSessionId: string,
  newSessionId: string,
): HandOffResourceTransferResult['teams'] {
  const transferred: HandOffResourceTransferResult['teams']['transferred'] = [];
  const failed: HandOffResourceTransferResult['teams']['failed'] = [];
  const rollback: Array<() => void> = [];
  const postCommitEvents: Array<() => void> = [];

  let memberships: ReturnType<typeof agentDeckTeamRepo.findActiveMembershipsBySession>;
  try {
    memberships = agentDeckTeamRepo.findActiveMembershipsBySession(callerSessionId);
  } catch (e) {
    return {
      status: 'failed',
      transferred,
      failed: [
        {
          teamId: '*',
          role: 'teammate',
          reason: `list-memberships-failed: ${errorMessage(e)}`,
        },
      ],
    };
  }

  const candidates: Array<{ teamId: string; role: 'lead' | 'teammate' }> = [];
  for (const m of memberships) {
    const role = m.role;
    try {
      const team = agentDeckTeamRepo.get(m.teamId);
      if (!team) {
        failed.push({ teamId: m.teamId, role, reason: 'team-not-found' });
        continue;
      }
      if (team.archivedAt !== null) {
        failed.push({ teamId: m.teamId, role, reason: 'team-archived' });
        continue;
      }
      candidates.push({ teamId: m.teamId, role });
    } catch (e) {
      failed.push({ teamId: m.teamId, role, reason: errorMessage(e) });
    }
  }

  if (failed.length > 0) {
    return {
      status: 'failed',
      transferred,
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
      failed,
    };
  }

  for (const emitEvent of postCommitEvents) {
    emitEvent();
  }

  return {
    status: 'ok',
    transferred,
    failed,
  };
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

export function transferHandOffResources(input: {
  callerSessionId: string;
  callerRow: SessionRecord;
  newSessionId: string;
}): HandOffResourceTransferResult {
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

  const teams = transferTeams(input.callerSessionId, input.newSessionId);
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

  return { tasks, teams, worktreeMarker: marker };
}
