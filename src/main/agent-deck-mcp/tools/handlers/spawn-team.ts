import { sessionManager } from '@main/session/manager';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { eventBus } from '@main/event-bus';
import { safeDiagnostic, safeDisplayText, toSafeErrorDetails } from '@main/utils/safe-diagnostic';
import { err, type HandlerResult } from '../helpers';
import type { CallerContext } from '../../types';
import log from '@main/utils/logger';

const logger = log.scope('mcp-spawn');

export interface SpawnRollbackIssue {
  phase: string;
  detail: string;
}

export interface SpawnTeamState {
  teamId: string | null;
  teamCreatedNow: boolean;
  callerSessionId: string;
  targetSessionId: string;
  callerMembershipWasActive: boolean;
  targetMembershipWasActive: boolean;
  callerMembershipAttempted: boolean;
  targetMembershipAttempted: boolean;
  callerMembershipIntroduced: boolean;
  targetMembershipIntroduced: boolean;
}

export type SpawnTeamEnsureResult =
  | {
      ok: true;
      teamIdEarly: string | null;
      teamCreatedNow: boolean;
    }
  | {
      ok: false;
      result: HandlerResult;
    };

export interface SpawnTeamCleanupResult {
  ok: boolean;
  removed: boolean;
  issues: SpawnRollbackIssue[];
}

function safeErrorMessage(error: unknown): string {
  return safeDisplayText(toSafeErrorDetails(error).message);
}

function teamPreflightError(input: {
  teamName: string;
  step: 'lookup' | 'ensure' | 'membership-list';
  error: unknown;
  cleanup?: SpawnTeamCleanupResult;
}): HandlerResult {
  const cleanup = input.cleanup ?? { ok: true, removed: false, issues: [] };
  const residualState = cleanup.ok ? [] : ['empty-team-may-remain'];
  const nextAction = cleanup.ok
    ? `Fix the team ${input.step} condition and retry spawn_session with teamName "${input.teamName}". No provider session was created.`
    : `Do not retry yet. In Agent Deck Teams, delete the empty team "${input.teamName}", then retry spawn_session.`;
  logger.warn('[mcp spawn_session] team preflight failed', safeDiagnostic({
    phase: 'team-preflight',
    step: input.step,
    outcome: 'failed',
    teamName: input.teamName,
    error: input.error,
    cleanup,
  }));
  return err(
    `team preflight failed during ${input.step} for "${input.teamName}": ${safeErrorMessage(input.error)}`,
    nextAction,
    {
      phase: 'team-preflight',
      preflightStep: input.step,
      retryValid: cleanup.ok,
      residualState,
      nextAction,
      cleanup,
    },
  );
}

export function ensureSpawnTeam(teamName: string | undefined): SpawnTeamEnsureResult {
  if (!teamName) {
    return { ok: true, teamIdEarly: null, teamCreatedNow: false };
  }

  let existingTeamId: string | null = null;
  try {
    existingTeamId = agentDeckTeamRepo.getByActiveName(teamName)?.id ?? null;
  } catch (error) {
    return {
      ok: false,
      result: teamPreflightError({ teamName, step: 'lookup', error }),
    };
  }

  let teamId: string;
  try {
    const team = agentDeckTeamRepo.ensureByName(teamName, { source: 'mcp' });
    if (!team.id) throw new Error('team repository returned an empty team id');
    if (existingTeamId && existingTeamId !== team.id) {
      throw new Error('team repository returned a different active team id');
    }
    teamId = team.id;
  } catch (error) {
    return {
      ok: false,
      result: teamPreflightError({ teamName, step: 'ensure', error }),
    };
  }

  try {
    const members = agentDeckTeamRepo.listAllMembers(teamId);
    return {
      ok: true,
      teamIdEarly: teamId,
      teamCreatedNow: existingTeamId === null && members.length === 0,
    };
  } catch (error) {
    const cleanup = cleanupEmptySpawnTeam({
      teamCreatedNow: existingTeamId === null,
      teamIdEarly: teamId,
      failureLabel: 'membership-list preflight failure',
      skipMembershipCheck: existingTeamId === null,
    });
    return {
      ok: false,
      result: teamPreflightError({
        teamName,
        step: 'membership-list',
        error,
        cleanup,
      }),
    };
  }
}

export function cleanupEmptySpawnTeam(input: {
  teamCreatedNow: boolean;
  teamIdEarly: string | null;
  failureLabel: string;
  /** Safe only before any await or membership write after creating a brand-new team. */
  skipMembershipCheck?: boolean;
}): SpawnTeamCleanupResult {
  if (!input.teamCreatedNow || !input.teamIdEarly) {
    return { ok: true, removed: false, issues: [] };
  }

  try {
    if (!input.skipMembershipCheck) {
      const remainingMembers = agentDeckTeamRepo.listAllMembers(input.teamIdEarly);
      if (remainingMembers.length > 0) {
        return { ok: true, removed: false, issues: [] };
      }
    }
    agentDeckTeamRepo.hardDelete(input.teamIdEarly);
    return { ok: true, removed: true, issues: [] };
  } catch (error) {
    const issue = {
      phase: 'team-cleanup',
      detail: safeErrorMessage(error),
    };
    logger.warn('[mcp spawn_session] team cleanup failed', safeDiagnostic({
      phase: issue.phase,
      outcome: 'failed',
      failureLabel: input.failureLabel,
      teamId: input.teamIdEarly,
      error,
    }));
    return { ok: false, removed: false, issues: [issue] };
  }
}

export async function completeSpawnTeamMembership(input: {
  teamName: string | undefined;
  teamIdEarly: string | null;
  teamCreatedNow: boolean;
  caller: CallerContext;
  callerExists: boolean;
  sid: string;
  teammateDisplayName: string | null;
  batonRole?: 'lead' | 'teammate';
}): Promise<
  | { ok: true; teamId: string | null; teamState: SpawnTeamState }
  | { ok: false; phase: 'team-membership'; error: unknown; teamState: SpawnTeamState }
> {
  const teamState: SpawnTeamState = {
    teamId: input.teamIdEarly,
    teamCreatedNow: input.teamCreatedNow,
    callerSessionId: input.caller.callerSessionId,
    targetSessionId: input.sid,
    callerMembershipWasActive: false,
    targetMembershipWasActive: false,
    callerMembershipAttempted: false,
    targetMembershipAttempted: false,
    callerMembershipIntroduced: false,
    targetMembershipIntroduced: false,
  };
  if (!input.teamName || !input.teamIdEarly) {
    return { ok: true, teamId: input.teamIdEarly, teamState };
  }

  const teamId = input.teamIdEarly;
  try {
    if (input.callerExists) {
      const existingCaller = agentDeckTeamRepo.findActiveMembershipIn(
        teamId,
        input.caller.callerSessionId,
      );
      teamState.callerMembershipWasActive = existingCaller !== null;
      if (existingCaller) {
        if (existingCaller.role !== 'lead') {
          throw new Error(`caller ${input.caller.callerSessionId} is not a lead in team ${teamId}`);
        }
      } else {
        teamState.callerMembershipAttempted = true;
        agentDeckTeamRepo.addMember({
          teamId,
          sessionId: input.caller.callerSessionId,
          role: 'lead',
          displayName: null,
        });
        teamState.callerMembershipIntroduced = true;
        sessionManager.notifyTeamMembershipChanged(input.caller.callerSessionId);
        eventBus.emit('agent-deck-team-member-changed', {
          teamId,
          sessionId: input.caller.callerSessionId,
          kind: 'joined',
        });
      }
    }

    const existingTarget = agentDeckTeamRepo.findActiveMembershipIn(teamId, input.sid);
    teamState.targetMembershipWasActive = existingTarget !== null;
    if (existingTarget) {
      throw new Error(`target ${input.sid} is already active in team ${teamId}`);
    }
    teamState.targetMembershipAttempted = true;
    agentDeckTeamRepo.addMember({
      teamId,
      sessionId: input.sid,
      role: input.batonRole ?? 'teammate',
      displayName: input.teammateDisplayName,
    });
    teamState.targetMembershipIntroduced = true;
    sessionManager.notifyTeamMembershipChanged(input.sid);
    eventBus.emit('agent-deck-team-member-changed', {
      teamId,
      sessionId: input.sid,
      kind: 'joined',
    });
  } catch (error) {
    try {
      if (
        teamState.callerMembershipAttempted &&
        !teamState.callerMembershipIntroduced &&
        !teamState.callerMembershipWasActive
      ) {
        teamState.callerMembershipIntroduced =
          agentDeckTeamRepo.findActiveMembershipIn(
            teamId,
            input.caller.callerSessionId,
          )?.role === 'lead';
      }
      if (
        teamState.targetMembershipAttempted &&
        !teamState.targetMembershipIntroduced &&
        !teamState.targetMembershipWasActive
      ) {
        teamState.targetMembershipIntroduced =
          agentDeckTeamRepo.findActiveMembershipIn(teamId, input.sid) !== null;
      }
    } catch (reconciliationError) {
      logger.warn('[mcp spawn_session] membership failure reconciliation failed', safeDiagnostic({
        phase: 'team-membership-reconciliation',
        outcome: 'failed',
        teamId,
        targetSessionId: input.sid,
        error: reconciliationError,
      }));
    }
    logger.warn('[mcp spawn_session] team membership failed', safeDiagnostic({
      phase: 'team-membership',
      outcome: 'failed',
      teamId,
      targetSessionId: input.sid,
      error,
    }));
    return { ok: false, phase: 'team-membership', error, teamState };
  }

  return { ok: true, teamId, teamState };
}

export function rollbackSpawnTeamMembership(
  teamState: SpawnTeamState,
): SpawnTeamCleanupResult {
  const issues: SpawnRollbackIssue[] = [];
  const { teamId } = teamState;
  if (!teamId) return { ok: true, removed: false, issues };

  const leaveIntroducedMember = (
    sessionId: string,
    introduced: boolean,
    attempted: boolean,
    wasActive: boolean,
    label: 'target' | 'caller',
  ): void => {
    if (!introduced && (!attempted || wasActive)) return;
    try {
      if (agentDeckTeamRepo.findActiveMembershipIn(teamId, sessionId)) {
        agentDeckTeamRepo.leaveTeam(teamId, sessionId);
      }
      try {
        sessionManager.notifyTeamMembershipChanged(sessionId);
        eventBus.emit('agent-deck-team-member-changed', {
          teamId,
          sessionId,
          kind: 'left',
        });
      } catch (diagnosticError) {
        logger.warn('[mcp spawn_session] membership cleanup notification failed', safeDiagnostic({
          phase: `team-${label}-notification`,
          outcome: 'failed',
          teamId,
          sessionId,
          error: diagnosticError,
        }));
      }
    } catch (error) {
      issues.push({
        phase: `team-${label}-membership`,
        detail: safeErrorMessage(error),
      });
    }
  };

  leaveIntroducedMember(
    teamState.targetSessionId,
    teamState.targetMembershipIntroduced,
    teamState.targetMembershipAttempted,
    teamState.targetMembershipWasActive,
    'target',
  );
  leaveIntroducedMember(
    teamState.callerSessionId,
    teamState.callerMembershipIntroduced,
    teamState.callerMembershipAttempted,
    teamState.callerMembershipWasActive,
    'caller',
  );
  const teamCleanup = cleanupEmptySpawnTeam({
    teamCreatedNow: teamState.teamCreatedNow,
    teamIdEarly: teamId,
    failureLabel: 'spawn transaction rollback',
  });
  issues.push(...teamCleanup.issues);
  return {
    ok: issues.length === 0,
    removed: teamCleanup.removed,
    issues,
  };
}
