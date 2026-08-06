import type { CodexAppServerClient } from '../../app-server/client';
import type { InternalSession } from '../types';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';
import type { CodexBridgeRuntimeHost } from '../runtime-host-core';

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
  runtimeHost: CodexBridgeRuntimeHost;
}

export interface CodexForkCleanupIssue {
  phase:
    | 'child-abort'
    | 'native-delete'
    | 'application-delete'
    | 'claim-release'
    | 'token-release'
    | 'client-dispose';
  targetId: string;
}

export class CodexForkDiscardError extends Error {
  readonly issues: readonly CodexForkCleanupIssue[];
  readonly residualState = ['codex-fork-child-artifacts'] as const;

  constructor(issues: readonly CodexForkCleanupIssue[]) {
    super(
      `Codex fork discard incomplete during ${[
        ...new Set(issues.map((issue) => issue.phase)),
      ].join(', ')}`,
    );
    this.name = 'CodexForkDiscardError';
    this.issues = issues;
  }
}

export async function cleanupCodexFork(
  state: CodexForkCleanupState,
  deps: CodexForkCleanupDeps,
): Promise<void> {
  const issues: CodexForkCleanupIssue[] = [];
  const recordIssue = (
    phase: CodexForkCleanupIssue['phase'],
    targetId: string,
    error: unknown,
  ): void => {
    issues.push({ phase, targetId });
    deps.runtimeHost.logger('codex-fork-rollback').warn(
      '[codex-fork] cleanup step failed',
      safeDiagnostic({
      phase,
      outcome: 'failed',
      targetId,
      error,
      }),
    );
  };
  const canonicalId = state.nativeChildId;
  if (state.internal) {
    state.internal.intentionallyClosed = true;
    try {
      state.internal.currentTurn?.abort();
    } catch (err) {
      recordIssue('child-abort', canonicalId ?? state.tempId, err);
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
      recordIssue('native-delete', canonicalId, err);
    }
  }

  const childIds = [...new Set([canonicalId, state.tempId].filter(isString))]
    .filter((id) => id !== state.sourceApplicationId && id !== state.sourceNativeId);
  if (state.tempRegistered) {
    for (const id of childIds) {
      try {
        await deps.lifecycle.deleteSession(id);
      } catch (err) {
        recordIssue('application-delete', id, err);
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
      recordIssue('claim-release', id, err);
    }
    try {
      deps.lifecycle.releaseToken(id);
    } catch (err) {
      recordIssue('token-release', id, err);
    }
  }

  if (state.targetClient && state.targetClient !== state.sourceClient) {
    try {
      state.targetClient.dispose();
    } catch (err) {
      recordIssue('client-dispose', canonicalId ?? state.tempId, err);
    }
  }
  if (issues.length > 0) throw new CodexForkDiscardError(issues);
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
