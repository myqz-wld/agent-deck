import { sessionManager } from '@main/session/manager';
import { agentDeckTeamRepo, TeamInvariantError } from '@main/store/agent-deck-team-repo';
import { eventBus } from '@main/event-bus';
import { err, type HandlerResult } from '../helpers';
import type { CallerContext } from '../../types';
import log from '@main/utils/logger';

const logger = log.scope('mcp-spawn');

export interface SpawnTeamEnsureResult {
  teamIdEarly: string | null;
  teamCreatedNow: boolean;
}

export function ensureSpawnTeam(teamName: string | undefined): SpawnTeamEnsureResult {
  if (!teamName) {
    return { teamIdEarly: null, teamCreatedNow: false };
  }

  try {
    const team = agentDeckTeamRepo.ensureByName(teamName, { source: 'mcp' });
    return {
      teamIdEarly: team.id,
      teamCreatedNow: agentDeckTeamRepo.listAllMembers(team.id).length === 0,
    };
  } catch (e) {
    // ensure 失败时 lead context block + placeholder 都不注入；後續 addMember 也跳過。
    logger.warn(`[mcp spawn_session] team ensureByName failed for "${teamName}":`, e);
    return { teamIdEarly: null, teamCreatedNow: false };
  }
}

export function cleanupEmptySpawnTeam(input: {
  teamCreatedNow: boolean;
  teamIdEarly: string | null;
  failureLabel: string;
}): void {
  if (!input.teamCreatedNow || !input.teamIdEarly) return;

  try {
    const remainingMembers = agentDeckTeamRepo.listAllMembers(input.teamIdEarly);
    if (remainingMembers.length === 0) {
      agentDeckTeamRepo.hardDelete(input.teamIdEarly);
    }
  } catch (cleanupErr) {
    logger.warn(
      `[mcp spawn_session] team cleanup after ${input.failureLabel} failed for ${input.teamIdEarly}:`,
      cleanupErr,
    );
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
}): Promise<{ ok: true; teamId: string | null } | { ok: false; result: HandlerResult }> {
  const teamId = input.teamIdEarly;
  if (!input.teamName || !teamId) {
    return { ok: true, teamId };
  }

  try {
    // caller 自动以 lead role 加入（如已 active 则保留）。caller 不在 sessions 表
    // （external __external__ 等）时跳过。
    if (input.callerExists) {
      try {
        agentDeckTeamRepo.addMember({
          teamId,
          sessionId: input.caller.callerSessionId,
          role: 'lead',
          displayName: null,
        });
        sessionManager.notifyTeamMembershipChanged(input.caller.callerSessionId);
        eventBus.emit('agent-deck-team-member-changed', {
          teamId,
          sessionId: input.caller.callerSessionId,
          kind: 'joined',
        });
      } catch (e) {
        if (!(e instanceof TeamInvariantError)) throw e;
        const callerMembership = agentDeckTeamRepo.findActiveMembershipIn(
          teamId,
          input.caller.callerSessionId,
        );
        if (callerMembership?.role !== 'lead') throw e;
      }
    }

    agentDeckTeamRepo.addMember({
      teamId,
      sessionId: input.sid,
      role: input.batonRole ?? 'teammate',
      displayName: input.teammateDisplayName,
    });
    sessionManager.notifyTeamMembershipChanged(input.sid);
    eventBus.emit('agent-deck-team-member-changed', {
      teamId,
      sessionId: input.sid,
      kind: 'joined',
    });
  } catch (e) {
    logger.warn(`[mcp spawn_session] addMember failed for "${input.teamName}":`, e);
    try {
      await sessionManager.close(input.sid);
    } catch (closeErr) {
      logger.warn(
        `[mcp spawn_session] orphan session close after addMember failure failed for ${input.sid}:`,
        closeErr,
      );
    }
    cleanupEmptySpawnTeam({
      teamCreatedNow: input.teamCreatedNow,
      teamIdEarly: teamId,
      failureLabel: 'addMember failure',
    });
    return {
      ok: false,
      result: err(
        `team setup failed for "${input.teamName}": ${e instanceof Error ? e.message : String(e)}`,
        'Session was spawned but team membership could not be established (e.g. lead count limit reached, or a DB write error). The orphan session was closed and any empty team created in this call was removed. Fix the team condition and retry spawn_session, or spawn without teamName for a standalone session.',
      ),
    };
  }

  return { ok: true, teamId };
}
