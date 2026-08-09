/** Codex source-runtime retirement after a successful MCP handoff. */
import type { CodexAppServerClient } from '../app-server/client';
import { extractAttachmentPaths } from './input-pack';
import type { InternalSession } from './types';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';
import type { CodexBridgeRuntimeHost } from './runtime-host-core';

export interface CodexSessionRetirementContext {
  sessions: Map<string, InternalSession>;
  clients: Map<string, CodexAppServerClient>;
  releaseClaim: (sessionId: string) => void;
  releaseToken: (sessionId: string) => void;
  runtimeHost: CodexBridgeRuntimeHost;
}

export interface CodexStrictRetirementIssue {
  phase: 'missing-client' | 'client-dispose' | 'claim-release' | 'token-release';
  sessionId: string;
}

export class CodexStrictRetirementError extends Error {
  readonly issues: readonly CodexStrictRetirementIssue[];
  readonly residualState = ['codex-runtime-ownership'] as const;

  constructor(issues: readonly CodexStrictRetirementIssue[]) {
    super(
      `Codex rollback close incomplete during ${[
        ...new Set(issues.map((issue) => issue.phase)),
      ].join(', ')}`,
    );
    this.name = 'CodexStrictRetirementError';
    this.issues = issues;
  }
}

/**
 * Seal the old owner synchronously. The active turn is deliberately left untouched so its
 * hand_off_session tool result can reach the provider before the runtime is disposed.
 */
export function armCodexSessionRetirement(
  internal: InternalSession,
  runtimeHost: CodexBridgeRuntimeHost,
  deletePendingAttachments = false,
): void {
  if (internal.retirementFinalized) return;
  internal.retireAfterCurrentTurn = true;
  internal.deletePendingAttachmentsOnRetirement ||= deletePendingAttachments;
  discardPendingCodexInputs(internal, deletePendingAttachments, runtimeHost);
}

export function assertCodexSessionAcceptsInput(internal: InternalSession): void {
  if (!internal.retireAfterCurrentTurn && !internal.retirementFinalized) return;
  throw new Error('Codex source runtime is retiring after handoff; route input to its successor.');
}

/** Idempotently remove every live runtime resource owned by one retired source session. */
export function finalizeCodexSessionRetirement(
  ctx: CodexSessionRetirementContext,
  internal: InternalSession,
): void {
  if (internal.retirementFinalized) return;
  internal.retirementFinalized = true;
  internal.retireAfterCurrentTurn = true;
  discardPendingCodexInputs(
    internal,
    internal.deletePendingAttachmentsOnRetirement === true,
    ctx.runtimeHost,
  );

  const runtimeIds = new Set<string>([internal.applicationSid]);
  if (internal.threadId) runtimeIds.add(internal.threadId);
  for (const [sessionId, candidate] of ctx.sessions) {
    if (candidate === internal) runtimeIds.add(sessionId);
  }

  for (const sessionId of runtimeIds) {
    if (ctx.sessions.get(sessionId) === internal) ctx.sessions.delete(sessionId);
  }

  const disposedClients = new Set<CodexAppServerClient>();
  for (const sessionId of runtimeIds) {
    const client = ctx.clients.get(sessionId);
    ctx.clients.delete(sessionId);
    if (client && !disposedClients.has(client)) {
      disposedClients.add(client);
      try {
        client.dispose();
      } catch (err) {
        ctx.runtimeHost.logger('codex-bridge').warn(
          `[codex-bridge] client dispose during retirement failed: ${sessionId}`,
          err,
        );
      }
    }
    try {
      ctx.releaseClaim(sessionId);
    } catch (err) {
      ctx.runtimeHost.logger('codex-bridge').warn(
        `[codex-bridge] SDK claim release during retirement failed: ${sessionId}`,
        err,
      );
    }
    try {
      ctx.releaseToken(sessionId);
    } catch (err) {
      ctx.runtimeHost.logger('codex-bridge').warn(
        `[codex-bridge] MCP token release during retirement failed: ${sessionId}`,
        err,
      );
    }
  }
}

export function finalizeCodexSessionRetirementForRollback(
  ctx: CodexSessionRetirementContext,
  internal: InternalSession,
): void {
  if (internal.retirementFinalized) return;
  internal.retireAfterCurrentTurn = true;
  discardPendingCodexInputs(
    internal,
    internal.deletePendingAttachmentsOnRetirement === true,
    ctx.runtimeHost,
  );
  const runtimeIds = collectRuntimeIds(ctx.sessions, internal);
  const clients = new Set<CodexAppServerClient>();
  for (const sessionId of runtimeIds) {
    const client = ctx.clients.get(sessionId);
    if (client) clients.add(client);
  }
  const issues: CodexStrictRetirementIssue[] = [];
  const recordIssue = (
    phase: CodexStrictRetirementIssue['phase'],
    sessionId: string,
    error?: unknown,
  ): void => {
    issues.push({ phase, sessionId });
    ctx.runtimeHost.logger('codex-bridge').warn('[codex-bridge] strict retirement step failed', safeDiagnostic({
      phase,
      outcome: 'failed',
      sessionId,
      ...(error === undefined ? {} : { error }),
    }));
  };
  if (clients.size === 0) recordIssue('missing-client', internal.applicationSid);
  for (const client of clients) {
    try {
      client.dispose();
    } catch (error) {
      recordIssue('client-dispose', internal.applicationSid, error);
    }
  }
  for (const sessionId of runtimeIds) {
    try {
      ctx.releaseClaim(sessionId);
    } catch (error) {
      recordIssue('claim-release', sessionId, error);
    }
    try {
      ctx.releaseToken(sessionId);
    } catch (error) {
      recordIssue('token-release', sessionId, error);
    }
  }
  if (issues.length > 0) throw new CodexStrictRetirementError(issues);
  for (const sessionId of runtimeIds) {
    if (ctx.sessions.get(sessionId) === internal) ctx.sessions.delete(sessionId);
    ctx.clients.delete(sessionId);
  }
  internal.retirementFinalized = true;
}

function collectRuntimeIds(
  sessions: ReadonlyMap<string, InternalSession>,
  internal: InternalSession,
): Set<string> {
  const runtimeIds = new Set<string>([internal.applicationSid]);
  if (internal.threadId) runtimeIds.add(internal.threadId);
  for (const [sessionId, candidate] of sessions) {
    if (candidate === internal) runtimeIds.add(sessionId);
  }
  return runtimeIds;
}

function discardPendingCodexInputs(
  internal: InternalSession,
  deleteAttachments: boolean,
  runtimeHost: CodexBridgeRuntimeHost,
): void {
  internal.submittingUserMessage?.requestController?.abort();
  internal.submittingUserMessage = null;
  const orphanPaths = new Set<string>();
  for (const input of internal.pendingMessages) {
    for (const path of extractAttachmentPaths(input)) orphanPaths.add(path);
  }
  internal.pendingMessages.length = 0;
  if (internal.pendingDeferredUserEvents) internal.pendingDeferredUserEvents.length = 0;
  if (internal.pendingHandOffMessages) internal.pendingHandOffMessages.length = 0;
  internal.acceptedEnqueueFingerprints?.clear();
  if (!deleteAttachments) return;
  for (const path of orphanPaths) {
    void runtimeHost.deleteUploadIfExists(path).catch(() => {
      // Best effort; the stale-upload reaper remains the final fallback.
    });
  }
}
