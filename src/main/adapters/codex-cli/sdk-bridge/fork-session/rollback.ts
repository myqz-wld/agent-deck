import type { CodexAppServerClient } from '../../app-server/client';
import type { InternalSession } from '../types';
import log from '@main/utils/logger';

const logger = log.scope('codex-fork-rollback');

export interface CodexForkLifecycleOps {
  allocateToken(sessionId: string): string;
  resolveToken(token: string): string | null;
  releaseToken(sessionId: string): void;
  claimSession(sessionId: string): void;
  releaseClaim(sessionId: string): void;
  hasClaim(sessionId: string): boolean;
  renameSession(fromId: string, toId: string): void;
  deleteSession(sessionId: string): Promise<void>;
}

export interface CodexForkCleanupState {
  sourceApplicationId: string;
  sourceNativeId: string;
  sourceClient: CodexAppServerClient;
  tempId: string;
  targetClient: CodexAppServerClient | null;
  nativeChildId: string | null;
  tempRegistered: boolean;
  internal: InternalSession | null;
}

export interface CodexForkCleanupDeps {
  sessions: Map<string, InternalSession>;
  codexBySession: Map<string, CodexAppServerClient>;
  lifecycle: CodexForkLifecycleOps;
}

export async function cleanupCodexFork(
  state: CodexForkCleanupState,
  deps: CodexForkCleanupDeps,
): Promise<void> {
  const canonicalId = state.nativeChildId;
  if (state.internal) {
    state.internal.intentionallyClosed = true;
    try {
      state.internal.currentTurn?.abort();
    } catch (err) {
      logger.warn('[codex-fork] child abort failed during cleanup', err);
    }
  }

  if (
    state.targetClient &&
    canonicalId &&
    canonicalId !== state.sourceNativeId
  ) {
    try {
      await deleteNativeChild(state.targetClient, canonicalId);
    } catch (err) {
      logger.warn(`[codex-fork] thread/delete failed for child ${canonicalId}`, err);
    }
  }

  const childIds = [...new Set([canonicalId, state.tempId].filter(isString))]
    .filter((id) => id !== state.sourceApplicationId && id !== state.sourceNativeId);
  if (state.tempRegistered) {
    for (const id of childIds) {
      try {
        await deps.lifecycle.deleteSession(id);
      } catch (err) {
        logger.warn(`[codex-fork] application session delete failed for ${id}`, err);
      }
    }
  }

  for (const id of childIds) {
    deps.sessions.delete(id);
    if (deps.codexBySession.get(id) === state.targetClient) {
      deps.codexBySession.delete(id);
    }
    try {
      deps.lifecycle.releaseClaim(id);
    } catch (err) {
      logger.warn(`[codex-fork] SDK claim release failed for ${id}`, err);
    }
    try {
      deps.lifecycle.releaseToken(id);
    } catch (err) {
      logger.warn(`[codex-fork] MCP token release failed for ${id}`, err);
    }
  }

  if (state.targetClient && state.targetClient !== state.sourceClient) {
    try {
      state.targetClient.dispose();
    } catch (err) {
      logger.warn('[codex-fork] target client dispose failed during cleanup', err);
    }
  }
}

/**
 * Mandatory team rollback closes the registered child before invoking discard(). That close
 * disposes the mapped app-server client, so native deletion must be able to reopen the same
 * target-owned configuration without ever borrowing the caller client/token.
 */
async function deleteNativeChild(
  targetClient: CodexAppServerClient,
  nativeChildId: string,
): Promise<void> {
  if (!targetClient.isDisposed) {
    try {
      await targetClient.deleteThread(nativeChildId);
      return;
    } catch (error) {
      // A concurrent close can dispose the client while thread/delete is starting. Retry only
      // when disposal, rather than a live provider error, explains the failure.
      if (!targetClient.isDisposed) throw error;
    }
  }

  const cleanupClient = targetClient.createSiblingClient();
  try {
    await cleanupClient.deleteThread(nativeChildId);
  } finally {
    cleanupClient.dispose();
  }
}

function isString(value: string | null): value is string {
  return typeof value === 'string';
}
