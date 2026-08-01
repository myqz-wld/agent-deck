/**
 * Session lifecycle helpers shared by the SessionManager facade.
 * Terminal paths preserve close epochs, browser cleanup, team side-effect
 * ordering, and dual-identity deletion fencing.
 */
import type { SessionRecord } from '@shared/types';
import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import { disposeSessionBrowser } from '@main/browser-use/session-browser';
import {
  leaveTeamsAndAutoArchive,
  archiveTeamsIfOrphaned,
  unarchiveTeamsForRevivedLead,
  applyClosedSideEffects,
} from '../manager-team-coordinator';
import type { SessionCloseFn, SessionManagerInternalState } from './_deps';
import { bumpCloseEpochImpl } from './_deps';
import log from '@main/utils/logger';
import { handOffCutoverCoordinator } from '../hand-off/cutover-coordinator';
import { reactivateHandOffSource } from '../hand-off/source-reactivation';
import {
  assertWorktreeTransitionAllowsDelete,
} from '../worktree-transition/lifecycle-policy';

const logger = log.scope('session-manager-lifecycle');
// Purge must wait until close marker and team side effects have finished.
const pendingCloseSideEffects = new Map<string, number>();

export interface ClosedSideEffectOptions {
  logPrefix?: string;
  onClearedBeforeLeave?: () => void;
}

export function hasPendingCloseSideEffectsImpl(sessionId: string): boolean {
  return (pendingCloseSideEffects.get(sessionId) ?? 0) > 0;
}

export function runClosedSideEffectsImpl(
  sessionId: string,
  opts: ClosedSideEffectOptions,
): Promise<void> {
  pendingCloseSideEffects.set(
    sessionId,
    (pendingCloseSideEffects.get(sessionId) ?? 0) + 1,
  );
  return applyClosedSideEffects(sessionId, {
    ...opts,
    awaitLeave: true,
  }).finally(() => {
    const remaining = (pendingCloseSideEffects.get(sessionId) ?? 1) - 1;
    if (remaining > 0) pendingCloseSideEffects.set(sessionId, remaining);
    else pendingCloseSideEffects.delete(sessionId);
  });
}

/**
 * Fence both application and CLI/native identities for the deletion TTL.
 * The explicit CLI id supports callers that already deleted the row; otherwise
 * the current row supplies it. A missing row still fences the supplied id.
 */
export function markRecentlyDeletedImpl(
  state: SessionManagerInternalState,
  sessionId: string,
  cliSessionId?: string | null,
): void {
  const now = Date.now();
  state.recentlyDeleted.set(sessionId, now);
  // Late SDK and hook events may use different identities for the same session.
  const cliSid = cliSessionId ?? sessionRepo.get(sessionId)?.cliSessionId;
  if (cliSid && cliSid !== sessionId) {
    state.recentlyDeleted.set(cliSid, now);
  }
}

/**
 * Advance active or dormant to closed. The close epoch changes before
 * persistence so in-flight recovery cancels. Browser disposal stays
 * non-blocking; tracked close side effects retain unsettled structured worktree
 * ownership, publish, leave teams, and auto-archive.
 */
export function markClosedImpl(
  state: SessionManagerInternalState,
  sessionId: string,
): void {
  const r = sessionRepo.get(sessionId);
  if (!r || (r.lifecycle !== 'dormant' && r.lifecycle !== 'active')) return;
  // Only a real transition establishes close intent and cancels recovery.
  handOffCutoverCoordinator.revokeSource(sessionId);
  bumpCloseEpochImpl(state, sessionId);
  sessionRepo.setLifecycle(sessionId, 'closed', Date.now(), { clearPinned: true });
  void disposeSessionBrowser(sessionId);
  void runClosedSideEffectsImpl(sessionId, {
    logPrefix: '[session-mgr] markClosed',
    onClearedBeforeLeave: () => {
      const updated = sessionRepo.get(sessionId);
      if (updated) eventBus.emit('session-upserted', updated);
    },
  }).catch(() => {
    // applyClosedSideEffects owns the detailed error log.
  });
}

/**
 * Explicit close terminates the adapter but retains the session and history.
 * Order: establish close intent, await the adapter, persist closed, dispose the
 * browser, then publish, release the MCP token,
 * leave teams, and auto-archive. Natural scheduler closure does not terminate the adapter.
 */
export async function closeImpl(
  sessionId: string,
  sessionCloseFn: SessionCloseFn | null,
  state: SessionManagerInternalState,
): Promise<void> {
  const session = sessionRepo.get(sessionId);
  if (!session) return; // 已删 / 从未存在 → noop
  // Record intent before awaiting the adapter so concurrent recovery observes it.
  handOffCutoverCoordinator.revokeSource(sessionId);
  bumpCloseEpochImpl(state, sessionId);
  if (session.agentId && sessionCloseFn) {
    try {
      await sessionCloseFn(session.agentId, sessionId);
    } catch (err) {
      logger.warn(`[session-mgr] adapter close failed during close(): ${sessionId}`, err);
    }
  }
  sessionRepo.setLifecycle(sessionId, 'closed', Date.now(), { clearPinned: true });
  await disposeSessionBrowser(sessionId);
  await runClosedSideEffectsImpl(sessionId, {
    logPrefix: '[session-mgr] close',
    onClearedBeforeLeave: () => {
      const updated = sessionRepo.get(sessionId);
      if (updated) eventBus.emit('session-upserted', updated);
      // Explicit close paths that bypass adapter cleanup must not leak a token.
      mcpSessionTokenMap.release(sessionId);
    },
  });
}

/**
 * Archive is orthogonal to lifecycle. Structured worktree ownership remains durable so a later
 * recovery can finish. Publish the fresh row, then auto-archive teams that lost their last lead.
 */
export async function archiveImpl(sessionId: string): Promise<void> {
  sessionRepo.setArchived(sessionId, Date.now());
  handOffCutoverCoordinator.abortSource(sessionId);
  const updated = sessionRepo.get(sessionId);
  if (updated) eventBus.emit('session-upserted', updated);
  await archiveTeamsIfOrphaned(sessionId);
}

/**
 * Clear the archive flag without changing lifecycle. Revive only teams archived
 * because their last active lead was archived.
 */
export async function unarchiveImpl(sessionId: string): Promise<void> {
  sessionRepo.setArchived(sessionId, null);
  const updated = sessionRepo.get(sessionId);
  if (updated) eventBus.emit('session-upserted', updated);
  await unarchiveTeamsForRevivedLead(sessionId);
}

/**
 * An explicit UI or CLI send may unarchive an existing archived session without
 * changing lifecycle. Passive cross-session send_message delivery is not this
 * user-resume signal.
 */
export async function unarchiveOnUserSendImpl(
  sessionId: string,
  unarchive: (sid: string) => Promise<void>,
): Promise<void> {
  const r = sessionRepo.get(sessionId);
  if (!r || r.archivedAt === null) return;
  await unarchive(sessionId);
}

/** Force an existing session active while clearing stale handoff ownership. */
export function reactivateImpl(sessionId: string): void {
  const r = sessionRepo.get(sessionId);
  if (!r) return;
  reactivateHandOffSource(sessionId, () => {
    sessionRepo.setLifecycle(sessionId, 'active', Date.now());
  });
  const updated = sessionRepo.get(sessionId);
  if (updated) eventBus.emit('session-upserted', updated);
}

/** Persist a live-session pin toggle and broadcast the committed row. */
export function setPinnedImpl(sessionId: string, pinned: boolean): SessionRecord {
  const updated = sessionRepo.setPinned(sessionId, pinned ? Date.now() : null);
  eventBus.emit('session-upserted', updated);
  return updated;
}

/**
 * Persist a non-default creation permission mode for both IPC and CLI paths.
 * `default` is implicit; stored modes include `acceptEdits`, `plan`, and
 * `bypassPermissions`.
 */
export function recordCreatedPermissionModeImpl(sessionId: string, mode: string | undefined): void {
  if (!mode || mode === 'default') return;
  sessionRepo.setPermissionMode(
    sessionId,
    mode as Parameters<typeof sessionRepo.setPermissionMode>[1],
  );
  const updated = sessionRepo.get(sessionId);
  if (updated) eventBus.emit('session-upserted', updated);
}

/**
 * Publish an affected session after a team mutation so renderer enrichment
 * refreshes membership. SessionManager owns this bridge rather than repo or MCP
 * layers.
 */
export function notifyTeamMembershipChangedImpl(sessionId: string): void {
  const rec = sessionRepo.get(sessionId);
  if (rec) eventBus.emit('session-upserted', rec);
}

/**
 * Delete ordering is required:
 * 1. leave active teams and auto-archive before CASCADE removes membership;
 * 2. await adapter close and browser disposal;
 * 3. capture the CLI id, delete the row, fence both identities, then publish
 *    removal.
 *
 * Adapter close failure does not preserve an orphan row. Awaiting close prevents
 * most late tails from recreating it; the dual-key deletion fence is the final
 * guard.
 */
export async function deleteImpl(
  state: SessionManagerInternalState,
  sessionId: string,
  sessionCloseFn: SessionCloseFn | null,
): Promise<void> {
  assertWorktreeTransitionAllowsDelete(sessionId);
  // Establish delete intent so in-flight recovery aborts before the row disappears.
  if (sessionRepo.get(sessionId)) handOffCutoverCoordinator.revokeSource(sessionId);
  bumpCloseEpochImpl(state, sessionId);
  await leaveTeamsAndAutoArchive(sessionId, 'deleted');
  const session = sessionRepo.get(sessionId);
  if (session?.agentId && sessionCloseFn) {
    try {
      await sessionCloseFn(session.agentId, sessionId);
    } catch (err) {
      logger.warn(`[session-mgr] close on delete failed: ${sessionId}`, err);
    }
  }
  await disposeSessionBrowser(sessionId);
  // Capture the CLI identity before deleting the row for dual-key fencing.
  const recBeforeDelete = sessionRepo.get(sessionId);
  const cliSidBeforeDelete = recBeforeDelete?.cliSessionId;
  sessionRepo.delete(sessionId);
  handOffCutoverCoordinator.restoreSource(sessionId);
  markRecentlyDeletedImpl(state, sessionId, cliSidBeforeDelete);
  // Row absence is now the durable recovery guard; bound the in-memory epoch map.
  state.closeEpoch.delete(sessionId);
  eventBus.emit('session-removed', sessionId);
}

// Keep the lifecycle module's public record type available to callers.
export type { SessionRecord };
