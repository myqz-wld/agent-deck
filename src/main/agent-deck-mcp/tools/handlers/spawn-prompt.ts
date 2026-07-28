import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { agentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
import type { ForkedSessionHandle } from '@main/adapters/types';
import type { SessionRecord } from '@shared/types';
import { safeDiagnostic, safeDisplayText, toSafeErrorDetails } from '@main/utils/safe-diagnostic';
import type { CallerContext } from '../../types';
import { err, type HandlerResult } from '../helpers';
import type { SpawnSessionArgs } from '../schemas';
import { buildLeadContextBlock } from './lead-context-block';
import { shouldWriteSpawnLink } from './spawn-link-guard';
import {
  rollbackSpawnTeamMembership,
  type SpawnRollbackIssue,
  type SpawnTeamState,
} from './spawn-team';
import log from '@main/utils/logger';

const logger = log.scope('mcp-spawn');

export interface BuildSpawnPromptContextInput {
  args: SpawnSessionArgs;
  caller: CallerContext;
  callerExists: boolean;
  leadRecord: Pick<SessionRecord, 'agentId' | 'title'> | null;
  leadDisplayName: string | null;
  promptToUse: string;
  teamIdEarly: string | null;
  handOffMode?: boolean;
  /** Main-only review forks keep lineage but must not inject a reply anchor into the child. */
  suppressLeadContext?: boolean;
}

export interface BuildSpawnPromptContextResult {
  shouldWriteNormalSpawnLink: boolean;
  willInjectWirePrefix: boolean;
  placeholderId: string | null;
  promptForSpawn: string;
}

export type SpawnTransactionFailurePhase =
  | 'team-membership'
  | 'anchor-insert'
  | 'anchor-mark';

export type PersistSpawnPromptAnchorResult =
  | { ok: true; anchorId: string }
  | {
      ok: false;
      phase: 'anchor-insert' | 'anchor-mark';
      error: unknown;
      anchorIdsToCleanup: string[];
    };

export interface SpawnTransactionRollback {
  close: 'closed' | 'failed';
  anchor: 'not-created' | 'removed' | 'failed';
  spawnLink: 'not-created' | 'cleared' | 'failed';
  team: 'not-requested' | 'cleaned' | 'failed';
  fork: 'not-forked' | 'discarded' | 'failed';
  issues: SpawnRollbackIssue[];
}

function safeErrorMessage(error: unknown): string {
  return safeDisplayText(toSafeErrorDetails(error).message);
}

export function buildSpawnPromptContext(
  input: BuildSpawnPromptContextInput,
): BuildSpawnPromptContextResult {
  const shouldWriteNormalSpawnLink =
    input.callerExists && shouldWriteSpawnLink({ handOffMode: input.handOffMode });
  const willInjectWirePrefix =
    shouldWriteNormalSpawnLink && input.suppressLeadContext !== true;
  let placeholderId: string | null = null;
  let promptForSpawn = input.promptToUse;

  if (willInjectWirePrefix) {
    const newPlaceholderId = crypto.randomUUID();
    placeholderId = newPlaceholderId;
    const leadAdapter = input.leadRecord?.agentId ?? 'unknown-adapter';
    const { wirePrefix, contextBlock } = buildLeadContextBlock({
      leadSessionId: input.caller.callerSessionId,
      teamId: input.teamIdEarly,
      leadDisplayName: input.leadDisplayName,
      leadAdapter,
      placeholderId: newPlaceholderId,
    });
    promptForSpawn = `${wirePrefix}${contextBlock}\n---\n\n${input.promptToUse}`;
  }

  return {
    shouldWriteNormalSpawnLink,
    willInjectWirePrefix,
    placeholderId,
    promptForSpawn,
  };
}

export function persistSpawnPromptAnchor(input: {
  placeholderId: string;
  teamId: string | null;
  fromSessionId: string;
  toSessionId: string;
  body: string;
}): PersistSpawnPromptAnchorResult {
  let persistedId: string | null = null;
  try {
    const placeholder = agentDeckMessageRepo.insert({
      id: input.placeholderId,
      teamId: input.teamId,
      fromSessionId: input.fromSessionId,
      toSessionId: input.toSessionId,
      body: input.body,
      replyToMessageId: null,
    });
    persistedId = placeholder.id;
    if (persistedId !== input.placeholderId) {
      throw new Error('message repository did not preserve the requested anchor id');
    }
  } catch (error) {
    logger.warn('[mcp spawn_session] anchor persistence failed', safeDiagnostic({
      phase: 'anchor-insert',
      outcome: 'failed',
      targetSessionId: input.toSessionId,
      anchorId: input.placeholderId,
      error,
    }));
    return {
      ok: false,
      phase: 'anchor-insert',
      error,
      anchorIdsToCleanup: [...new Set([input.placeholderId, persistedId].filter(isString))],
    };
  }

  try {
    const delivered = agentDeckMessageRepo.markDelivered(input.placeholderId, Date.now());
    if (!delivered || delivered.id !== input.placeholderId || delivered.status !== 'delivered') {
      throw new Error('message repository did not durably mark the spawn anchor delivered');
    }
  } catch (error) {
    logger.warn('[mcp spawn_session] anchor delivery mark failed', safeDiagnostic({
      phase: 'anchor-mark',
      outcome: 'failed',
      targetSessionId: input.toSessionId,
      anchorId: input.placeholderId,
      error,
    }));
    return {
      ok: false,
      phase: 'anchor-mark',
      error,
      anchorIdsToCleanup: [input.placeholderId],
    };
  }

  return { ok: true, anchorId: input.placeholderId };
}

export async function rollbackFailedSpawnTransaction(input: {
  sid: string;
  failurePhase: SpawnTransactionFailurePhase;
  failure: unknown;
  anchorIdsToCleanup: readonly string[];
  spawnLinkWritten: boolean;
  teamState: SpawnTeamState;
  forkHandle: ForkedSessionHandle | null;
  strictCloseTarget: ((sessionId: string) => Promise<void>) | null;
}): Promise<HandlerResult> {
  const issues: SpawnRollbackIssue[] = [];
  let close: SpawnTransactionRollback['close'] = 'closed';
  let anchor: SpawnTransactionRollback['anchor'] =
    input.anchorIdsToCleanup.length > 0 ? 'removed' : 'not-created';
  let spawnLink: SpawnTransactionRollback['spawnLink'] =
    input.spawnLinkWritten ? 'cleared' : 'not-created';
  let team: SpawnTransactionRollback['team'] =
    input.teamState.teamId ? 'cleaned' : 'not-requested';
  let fork: SpawnTransactionRollback['fork'] =
    input.forkHandle ? 'discarded' : 'not-forked';

  try {
    if (!input.strictCloseTarget) {
      throw new Error('target adapter does not expose strict rollback close');
    }
    await input.strictCloseTarget(input.sid);
    await sessionManager.close(input.sid);
    const afterClose = sessionRepo.get(input.sid);
    if (!afterClose || afterClose.lifecycle !== 'closed') {
      throw new Error('target durable lifecycle was not closed after provider shutdown');
    }
  } catch (error) {
    close = 'failed';
    issues.push({ phase: 'target-close', detail: safeErrorMessage(error) });
  }

  for (const anchorId of [...new Set(input.anchorIdsToCleanup)]) {
    try {
      agentDeckMessageRepo.cancel(anchorId, 'spawn-transaction-rollback');
      agentDeckMessageRepo.batchHardDelete([anchorId]);
      if (agentDeckMessageRepo.get(anchorId)) {
        throw new Error('anchor row remained after cancellation and hard delete');
      }
    } catch (error) {
      anchor = 'failed';
      issues.push({ phase: 'anchor-cleanup', detail: safeErrorMessage(error) });
    }
  }

  if (input.spawnLinkWritten) {
    try {
      if (sessionRepo.get(input.sid)) {
        sessionRepo.setSpawnLink(input.sid, null, 0);
        const unlinked = sessionRepo.get(input.sid);
        if (unlinked && (unlinked.spawnedBy !== null || unlinked.spawnDepth !== 0)) {
          throw new Error('spawn link remained after reset');
        }
      }
    } catch (error) {
      spawnLink = 'failed';
      issues.push({ phase: 'spawn-link-cleanup', detail: safeErrorMessage(error) });
    }
  }

  const teamCleanup = rollbackSpawnTeamMembership(input.teamState);
  if (!teamCleanup.ok) {
    team = 'failed';
    issues.push(...teamCleanup.issues);
  }

  if (input.forkHandle) {
    try {
      await input.forkHandle.discard();
    } catch (error) {
      fork = 'failed';
      issues.push({ phase: 'fork-discard', detail: safeErrorMessage(error) });
    }
  }

  const target = sessionRepo.get(input.sid);
  const residualState: string[] = [];
  if (close === 'failed') residualState.push('target-close-unverified');
  if (target && target.lifecycle !== 'closed') residualState.push('target-active-or-unknown');
  if (anchor === 'failed') residualState.push('reply-anchor');
  if (spawnLink === 'failed') residualState.push('spawn-link');
  if (team === 'failed') residualState.push('team-membership-or-empty-team');
  if (fork === 'failed') residualState.push('native-fork-artifacts');
  const retryValid = issues.length === 0 && residualState.length === 0;
  const nextAction = retryValid
    ? `Retry spawn_session with the same arguments. Target ${input.sid} was closed and collaboration state was removed.`
    : `Do not retry. Call shutdown_session({sessionId:"${input.sid}"}), verify the ${input.sid} provider process/runtime is absent, then delete target ${input.sid} from Agent Deck History. If provider shutdown cannot be verified, restart Agent Deck before deleting the target; retry spawn_session only after those checks pass.`;
  const rollback: SpawnTransactionRollback = {
    close,
    anchor,
    spawnLink,
    team,
    fork,
    issues,
  };
  logger.warn('[mcp spawn_session] transaction rolled back', safeDiagnostic({
    phase: input.failurePhase,
    outcome: retryValid ? 'rolled-back' : 'rollback-incomplete',
    targetSessionId: input.sid,
    rollback,
    residualState,
    retryValid,
    error: input.failure,
  }));
  const failureLabel =
    input.failurePhase === 'team-membership'
      ? 'team setup failed'
      : 'spawn_session transaction failed';
  return err(
    `${failureLabel} during ${input.failurePhase} for target ${input.sid}: ${safeErrorMessage(input.failure)}`,
    nextAction,
    {
      phase: input.failurePhase,
      targetSessionId: input.sid,
      rollback,
      residualState,
      retryValid,
      nextAction,
    },
  );
}

function isString(value: string | null): value is string {
  return typeof value === 'string';
}
