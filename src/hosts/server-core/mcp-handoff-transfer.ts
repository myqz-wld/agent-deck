import type { HandOffSessionResult } from '@main/agent-deck-mcp/tools/schemas';
import type { JsonObject } from '@contracts/index';
import type Database from 'better-sqlite3';
import {
  countDeliveringMessagesForSessionWithDb,
  retargetPendingMessagesForHandOffWithDb,
} from '@main/store/agent-deck-message-repo';
import {
  createAgentDeckTeamRepo,
  transferTeammateMembershipWithDb,
} from '@main/store/agent-deck-team-repo';
import { getDb } from '@main/store/db';
import {
  compressSessionHandOffAliasesWithDb,
  recordSessionHandOffAliasWithDb,
} from '@main/store/session-handoff-alias-repo';
import {
  transferActiveLeaseWithDb,
} from '@main/store/worktree-transition-repo';
import { getWorktreeTransitionWithDb } from '@main/store/worktree-transition-row';

import type { ServerCoreMcpPresentationPort } from './mcp-presentation-port';
import type { ServerCoreWorktreeRuntimePort } from './mcp-worktree-port';

type TransferResult = HandOffSessionResult['resourceTransfer'];

export interface ServerCoreHandOffTransferOptions {
  readonly successorCwd: string;
  readonly worktrees: ServerCoreWorktreeRuntimePort;
  readonly presentations: ServerCoreMcpPresentationPort;
  readonly notifyMembershipChanged: (sessionId: string) => void;
  readonly appendChange: (
    kind: string,
    entityId: string | null,
    payload: JsonObject,
  ) => void;
  readonly warn?: (message: string) => void;
  readonly now?: () => number;
  /** Deterministic test/transaction seam; production uses the initialized Core database. */
  readonly database?: Database.Database;
}

function safeAfterCommit(operation: () => void, warn: (() => void) | undefined): void {
  try {
    operation();
  } catch {
    try { warn?.(); } catch {}
  }
}

/** One SQLite commit moves every durable logical owner before source retirement begins. */
export function transferServerCoreHandOffResources(
  sourceSessionId: string,
  successorSessionId: string,
  options: ServerCoreHandOffTransferOptions,
): TransferResult {
  const db = options.database ?? getDb();
  const teams = createAgentDeckTeamRepo(db);
  const now = options.now ?? Date.now;
  const transaction = db.transaction((): TransferResult => {
    if (countDeliveringMessagesForSessionWithDb(db, sourceSessionId) !== 0) {
      throw new Error('Cross-session delivery crossed the handoff transaction boundary');
    }
    const allMemberships = teams.findActiveMembershipsBySession(sourceSessionId);
    const candidates = teams.findActiveTeamMembershipsBySession(sourceSessionId);
    const candidateIds = new Set(candidates.map((entry) => entry.teamId));
    const skipped: TransferResult['teams']['skipped'] = [];
    for (const membership of allMemberships) {
      if (candidateIds.has(membership.teamId)) continue;
      const team = teams.get(membership.teamId);
      if (team?.archivedAt !== null) {
        skipped.push({
          teamId: membership.teamId,
          role: membership.role,
          reason: 'team-archived',
        });
        continue;
      }
      throw new Error(`Active team membership query mismatch for ${membership.teamId}`);
    }

    const transferred: TransferResult['teams']['transferred'] = [];
    for (const membership of candidates) {
      if (membership.role === 'lead') {
        const result = teams.swapLead(
          membership.teamId,
          sourceSessionId,
          successorSessionId,
        );
        if (!result.swapped) {
          throw new Error(`Team lead transfer failed: ${result.reason}`);
        }
      } else {
        const result = transferTeammateMembershipWithDb(
          db,
          membership.teamId,
          sourceSessionId,
          successorSessionId,
        );
        if (!result.transferred) {
          throw new Error(`Team membership transfer failed: ${result.reason}`);
        }
      }
      transferred.push({ teamId: membership.teamId, role: membership.role });
    }

    const taskCount = Number(db.prepare(
      `UPDATE tasks
          SET owner_session_id = ?
        WHERE owner_session_id = ?`,
    ).run(successorSessionId, sourceSessionId).changes ?? 0);
    const transition = getWorktreeTransitionWithDb(db, sourceSessionId);
    let worktreeLease: TransferResult['worktreeLease'] = {
      status: 'skipped',
      worktreePath: null,
    };
    if (transition && transition.phase !== 'cleared') {
      if (transition.phase !== 'active') {
        throw new Error(
          `Worktree transition ${transition.sessionId}:${transition.generation} is pending`,
        );
      }
      if (transition.worktreePath !== options.successorCwd) {
        throw new Error('Successor cwd does not match the active worktree lease');
      }
      transferActiveLeaseWithDb(db, sourceSessionId, successorSessionId, now());
      worktreeLease = { status: 'ok', worktreePath: transition.worktreePath };
    }

    retargetPendingMessagesForHandOffWithDb(db, sourceSessionId, successorSessionId);
    compressSessionHandOffAliasesWithDb(db, sourceSessionId, successorSessionId);
    recordSessionHandOffAliasWithDb(db, sourceSessionId, successorSessionId, now());
    return {
      tasks: { status: 'ok', count: taskCount },
      teams: { status: 'ok', transferred, skipped, failed: [] },
      worktreeLease,
    };
  });
  const result = transaction.immediate();

  safeAfterCommit(
    () => options.presentations.transferSession(sourceSessionId, successorSessionId),
    options.warn ? () => options.warn!('Core presentation transfer failed after durable handoff') : undefined,
  );
  safeAfterCommit(
    () => options.worktrees.renameSession(sourceSessionId, successorSessionId),
    options.warn ? () => options.warn!('Core worktree runtime rename failed after durable handoff') : undefined,
  );
  safeAfterCommit(
    () => options.notifyMembershipChanged(sourceSessionId),
    options.warn ? () => options.warn!('Source membership refresh failed after durable handoff') : undefined,
  );
  safeAfterCommit(
    () => options.notifyMembershipChanged(successorSessionId),
    options.warn ? () => options.warn!('Successor membership refresh failed after durable handoff') : undefined,
  );
  safeAfterCommit(
    () => options.appendChange('session.handoff.resources', successorSessionId, {
      sourceSessionId,
      successorSessionId,
      taskCount: result.tasks.count,
      teamCount: result.teams.transferred.length,
      worktreeTransferred: result.worktreeLease.status === 'ok',
    }),
    options.warn ? () => options.warn!('Handoff resource change publication failed') : undefined,
  );
  return result;
}
