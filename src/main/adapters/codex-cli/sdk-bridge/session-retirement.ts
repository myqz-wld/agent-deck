/** Codex source-runtime retirement after a successful MCP handoff. */
import type { CodexAppServerClient } from '../app-server/client';
import { deleteUploadIfExists } from '@main/store/image-uploads';
import { extractAttachmentPaths } from './input-pack';
import type { InternalSession } from './types';
import log from '@main/utils/logger';

const logger = log.scope('codex-bridge');

export interface CodexSessionRetirementContext {
  sessions: Map<string, InternalSession>;
  clients: Map<string, CodexAppServerClient>;
  releaseClaim: (sessionId: string) => void;
  releaseToken: (sessionId: string) => void;
}

/**
 * Seal the old owner synchronously. The active turn is deliberately left untouched so its
 * hand_off_session tool result can reach the provider before the runtime is disposed.
 */
export function armCodexSessionRetirement(
  internal: InternalSession,
  deletePendingAttachments = false,
): void {
  if (internal.retirementFinalized) return;
  internal.retireAfterCurrentTurn = true;
  internal.deletePendingAttachmentsOnRetirement ||= deletePendingAttachments;
  discardPendingCodexInputs(internal, deletePendingAttachments);
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
        logger.warn(`[codex-bridge] client dispose during retirement failed: ${sessionId}`, err);
      }
    }
    try {
      ctx.releaseClaim(sessionId);
    } catch (err) {
      logger.warn(`[codex-bridge] SDK claim release during retirement failed: ${sessionId}`, err);
    }
    try {
      ctx.releaseToken(sessionId);
    } catch (err) {
      logger.warn(`[codex-bridge] MCP token release during retirement failed: ${sessionId}`, err);
    }
  }
}

function discardPendingCodexInputs(
  internal: InternalSession,
  deleteAttachments: boolean,
): void {
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
    void deleteUploadIfExists(path).catch(() => {
      // Best effort; the stale-upload reaper remains the final fallback.
    });
  }
}
