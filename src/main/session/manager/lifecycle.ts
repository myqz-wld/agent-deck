/** Desktop host binding for the host-neutral session lifecycle state machine. */
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
import log from '@main/utils/logger';
import { handOffCutoverCoordinator } from '../hand-off/cutover-coordinator';
import { reactivateHandOffSource } from '../hand-off/source-reactivation';
import { assertWorktreeTransitionAllowsDelete } from '../worktree-transition/lifecycle-policy';
import {
  SessionLifecycleCore,
  type ClosedSideEffectOptions,
  type SessionLifecycleCoreHost,
} from './lifecycle-core';

const logger = log.scope('session-manager-lifecycle');

const desktopSessionLifecycleHost: SessionLifecycleCoreHost = {
  repository: sessionRepo,
  now: () => Date.now(),
  disposeSessionBrowser,
  applyClosedSideEffects: (sessionId, options) =>
    applyClosedSideEffects(sessionId, options),
  archiveTeamsIfOrphaned,
  unarchiveTeamsForRevivedLead,
  leaveTeamsAndAutoArchive: (sessionId, reason) =>
    leaveTeamsAndAutoArchive(sessionId, reason),
  revokeHandOffSource: (sessionId) => handOffCutoverCoordinator.revokeSource(sessionId),
  abortHandOffSource: (sessionId) => handOffCutoverCoordinator.abortSource(sessionId),
  restoreHandOffSource: (sessionId) => handOffCutoverCoordinator.restoreSource(sessionId),
  reactivateHandOffSource,
  assertDeleteAllowed: assertWorktreeTransitionAllowsDelete,
  releaseSessionToken: (sessionId) => mcpSessionTokenMap.release(sessionId),
  publishSessionUpserted: (session) => eventBus.emit('session-upserted', session),
  publishSessionRemoved: (sessionId) => eventBus.emit('session-removed', sessionId),
  warn: (message, error) => logger.warn(message, error),
};

const lifecycle = new SessionLifecycleCore(desktopSessionLifecycleHost);

export function hasPendingCloseSideEffectsImpl(sessionId: string): boolean {
  return lifecycle.hasPendingCloseSideEffects(sessionId);
}

export function runClosedSideEffectsImpl(
  sessionId: string,
  options: ClosedSideEffectOptions,
): Promise<void> {
  return lifecycle.runClosedSideEffects(sessionId, options);
}

export function markRecentlyDeletedImpl(
  state: SessionManagerInternalState,
  sessionId: string,
  cliSessionId?: string | null,
): void {
  lifecycle.markRecentlyDeleted(state, sessionId, cliSessionId);
}

export function markClosedImpl(
  state: SessionManagerInternalState,
  sessionId: string,
): void {
  lifecycle.markClosed(state, sessionId);
}

export function closeImpl(
  sessionId: string,
  sessionClose: SessionCloseFn | null,
  state: SessionManagerInternalState,
): Promise<void> {
  return lifecycle.close(sessionId, sessionClose, state);
}

export function archiveImpl(sessionId: string): Promise<void> {
  return lifecycle.archive(sessionId);
}

export function unarchiveImpl(sessionId: string): Promise<void> {
  return lifecycle.unarchive(sessionId);
}

export function unarchiveOnUserSendImpl(
  sessionId: string,
  unarchive: (id: string) => Promise<void>,
): Promise<void> {
  return lifecycle.unarchiveOnUserSend(sessionId, unarchive);
}

export function reactivateImpl(sessionId: string): void {
  lifecycle.reactivate(sessionId);
}

export function setPinnedImpl(sessionId: string, pinned: boolean): SessionRecord {
  return lifecycle.setPinned(sessionId, pinned);
}

export function recordCreatedPermissionModeImpl(
  sessionId: string,
  mode: string | undefined,
): void {
  lifecycle.recordCreatedPermissionMode(sessionId, mode);
}

export function notifyTeamMembershipChangedImpl(sessionId: string): void {
  lifecycle.notifyTeamMembershipChanged(sessionId);
}

export function deleteImpl(
  state: SessionManagerInternalState,
  sessionId: string,
  sessionClose: SessionCloseFn | null,
): Promise<void> {
  return lifecycle.delete(state, sessionId, sessionClose);
}

export type { ClosedSideEffectOptions, SessionRecord };
