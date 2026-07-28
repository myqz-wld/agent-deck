import { randomUUID } from 'node:crypto';
import type { AgentEvent, DiffReviewRequest, DiffReviewResponse, SessionRecord } from '@shared/types';
import { adapterRegistry } from '@main/adapters/registry';
import { isAgentId } from '@main/adapters/options-builder';
import { eventBus } from '@main/event-bus';
import { dispatchAdapterMessageWithHandOffRedirect } from '@main/ipc/adapters-message-dispatch';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import log from '@main/utils/logger';
import { safeDiagnostic, safeErrorSummary } from '@main/utils/safe-diagnostic';
import { getProcessRunId } from '@main/utils/run-context';

export type McpDiffReviewDecision =
  | { decision: 'approved' }
  | { decision: 'revise'; feedback?: string }
  | { decision: 'timeout' };

interface PendingMcpDiffReview {
  payload: DiffReviewRequest;
  sourceSessionId: string;
  ownerSessionId: string;
  agentId: string;
  timer: NodeJS.Timeout | null;
  resolve: (decision: McpDiffReviewDecision) => void;
  state: 'active' | 'transferred';
  resolutionState: 'pending' | 'resolving' | 'cancelled';
  lateResponse: DiffReviewResponse | null;
}

export interface RequestDiffReviewInput extends Omit<DiffReviewRequest, 'type' | 'requestId'> {
  sessionId: string;
  agentId: string;
  timeoutMs?: number;
}

export interface DiffReviewServiceDependencies {
  createRequestId: () => string;
  ingest: (event: AgentEvent) => void;
  getSession: (sessionId: string) => SessionRecord | null;
  deliverLateDecision: (input: {
    sourceSessionId: string;
    request: DiffReviewRequest;
    response: DiffReviewResponse;
  }) => Promise<void>;
}

const logger = log.scope('diff-review-service');

function lateResponseSignature(response: DiffReviewResponse): string {
  return response.decision === 'approve'
    ? 'approve'
    : `revise:${response.feedback?.trim() ?? ''}`;
}

function buildLateDiffDecisionText(
  request: DiffReviewRequest,
  response: DiffReviewResponse,
): string {
  const subject = request.title?.trim() || request.filePath?.trim() || 'the presented diff';
  if (response.decision === 'approve') {
    return `The user approved ${subject} after its review gate transferred to this handoff successor. Continue from that decision.`;
  }
  const feedback = response.feedback?.trim();
  return feedback
    ? `The user requested revisions to ${subject} after its review gate transferred to this handoff successor.\n\nFeedback:\n${feedback}`
    : `The user requested revisions to ${subject} after its review gate transferred to this handoff successor.`;
}

const productionDependencies: DiffReviewServiceDependencies = {
  createRequestId: () => `mcp-diff-${randomUUID()}`,
  ingest: (event) => sessionManager.ingest(event),
  getSession: (sessionId) => sessionRepo.get(sessionId),
  deliverLateDecision: async ({ sourceSessionId, request, response }) => {
    const source = sessionRepo.get(sourceSessionId);
    if (!source || !isAgentId(source.agentId)) {
      throw new Error('The original diff-review session is unavailable.');
    }
    const adapter = adapterRegistry.get(source.agentId);
    if (!adapter) throw new Error('The original diff-review adapter is unavailable.');
    await dispatchAdapterMessageWithHandOffRedirect({
      sourceSessionId,
      sourceAdapter: adapter,
      text: buildLateDiffDecisionText(request, response),
      attachments: [],
      enqueueOptions: {
        idempotencyKey: `diff-review-late-decision:${request.requestId}`,
      },
    });
  },
};

export class DiffReviewService {
  private readonly pending = new Map<string, PendingMcpDiffReview>();

  constructor(private readonly deps: DiffReviewServiceDependencies = productionDependencies) {}

  request(input: RequestDiffReviewInput): Promise<McpDiffReviewDecision> {
    const requestId = this.deps.createRequestId();
    const payload: DiffReviewRequest = {
      type: 'diff-review',
      requestId,
      mode: input.mode,
      rationale: input.rationale,
      ...(input.title ? { title: input.title } : {}),
      ...(input.filePath ? { filePath: input.filePath } : {}),
      ...(input.language ? { language: input.language } : {}),
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(input.annotations ? { annotations: input.annotations } : {}),
      ...(input.pr ? { pr: input.pr } : {}),
      ...(input.conflict ? { conflict: input.conflict } : {}),
    };

    const createdAt = Date.now();
    let resolveDecision: (decision: McpDiffReviewDecision) => void = () => {};
    const promise = new Promise<McpDiffReviewDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const entry: PendingMcpDiffReview = {
      payload,
      sourceSessionId: input.sessionId,
      ownerSessionId: input.sessionId,
      agentId: input.agentId,
      timer: null,
      resolve: resolveDecision,
      state: 'active',
      resolutionState: 'pending',
      lateResponse: null,
    };
    if (input.timeoutMs && input.timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        if (this.pending.get(requestId) !== entry || entry.state !== 'active') return;
        this.pending.delete(requestId);
        this.emitCancelledIfPossible(entry);
        resolveDecision({ decision: 'timeout' });
      }, input.timeoutMs);
    }
    this.pending.set(requestId, entry);

    try {
      this.deps.ingest({
        sessionId: input.sessionId,
        agentId: input.agentId,
        kind: 'waiting-for-user',
        payload,
        ts: createdAt,
        source: 'sdk',
      });
    } catch (err) {
      this.pending.delete(requestId);
      if (entry.timer) clearTimeout(entry.timer);
      throw err;
    }

    return promise;
  }

  cancelForSession(
    sessionId: string,
    options: { emitCancelled?: boolean } = {},
  ): number {
    const emitCancelled = options.emitCancelled ?? true;
    let cancelled = 0;
    for (const entry of [...this.pending.values()]) {
      if (entry.ownerSessionId !== sessionId) continue;
      if (!this.pending.delete(entry.payload.requestId)) continue;
      entry.resolutionState = 'cancelled';
      if (entry.timer) clearTimeout(entry.timer);
      if (emitCancelled) this.emitCancelledIfPossible(entry);
      entry.resolve({ decision: 'timeout' });
      cancelled += 1;
    }
    return cancelled;
  }

  respond(sessionId: string, requestId: string, response: DiffReviewResponse): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.ownerSessionId !== sessionId) return false;
    if (entry.resolutionState === 'resolving') {
      if (
        entry.lateResponse &&
        lateResponseSignature(entry.lateResponse) === lateResponseSignature(response)
      ) return true;
      throw new Error('This diff decision is already being submitted.');
    }
    if (entry.resolutionState !== 'pending') return false;
    if (entry.state === 'transferred') {
      if (
        entry.lateResponse &&
        lateResponseSignature(entry.lateResponse) !== lateResponseSignature(response)
      ) {
        throw new Error('A transferred diff-decision retry must use the same decision.');
      }
      entry.lateResponse ??= { ...response };
      entry.resolutionState = 'resolving';
      void this.deliverTransferredDecision(entry);
      return true;
    }
    this.pending.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    if (response.decision === 'revise') {
      entry.resolve({
        decision: 'revise',
        ...(response.feedback?.trim() ? { feedback: response.feedback.trim() } : {}),
      });
    } else {
      entry.resolve({ decision: 'approved' });
    }
    return true;
  }

  listPending(sessionId: string): DiffReviewRequest[] {
    return [...this.pending.values()]
      .filter((entry) => entry.ownerSessionId === sessionId)
      .map((entry) => entry.payload);
  }

  listAllPending(agentId?: string): Record<string, DiffReviewRequest[]> {
    const out: Record<string, DiffReviewRequest[]> = {};
    for (const entry of this.pending.values()) {
      let session: SessionRecord | null;
      try {
        session = this.deps.getSession(entry.ownerSessionId);
      } catch (error) {
        logger.warn(
          `[diff-review] failed to hydrate request=${entry.payload.requestId} owner=${entry.ownerSessionId}`,
          safeErrorSummary(error),
        );
        continue;
      }
      if (!session || session.lifecycle === 'closed') continue;
      entry.agentId = session.agentId;
      if (agentId && entry.agentId !== agentId) continue;
      (out[entry.ownerSessionId] ??= []).push(entry.payload);
    }
    return out;
  }

  rehomeForHandOff(sourceSessionId: string, successorSessionId: string): number {
    let successor: SessionRecord | null = null;
    try {
      successor = this.deps.getSession(successorSessionId);
    } catch (error) {
      logger.warn(
        `[diff-review] failed to read successor metadata successor=${successorSessionId}`,
        safeErrorSummary(error),
      );
    }
    let moved = 0;
    for (const entry of this.pending.values()) {
      if (entry.ownerSessionId !== sourceSessionId) continue;
      const sourceAgentId = entry.agentId;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      if (entry.state === 'active') {
        entry.state = 'transferred';
        entry.resolve({ decision: 'timeout' });
      }
      entry.ownerSessionId = successorSessionId;
      entry.agentId = successor?.agentId ?? sourceAgentId;
      this.emitCancelledForOwner(entry, sourceSessionId, sourceAgentId);
      try {
        this.deps.ingest({
          sessionId: successorSessionId,
          agentId: entry.agentId,
          kind: 'waiting-for-user',
          payload: entry.payload,
          ts: Date.now(),
          source: 'sdk',
        });
      } catch (error) {
        logger.warn(
          `[diff-review] failed to project transferred gate request=${entry.payload.requestId} successor=${successorSessionId}`,
          safeErrorSummary(error),
        );
      }
      moved += 1;
    }
    return moved;
  }

  private async deliverTransferredDecision(entry: PendingMcpDiffReview): Promise<void> {
    try {
      await this.deps.deliverLateDecision({
        sourceSessionId: entry.sourceSessionId,
        request: entry.payload,
        response: entry.lateResponse!,
      });
      if (
        this.pending.get(entry.payload.requestId) === entry &&
        entry.resolutionState === 'resolving'
      ) {
        this.pending.delete(entry.payload.requestId);
      }
    } catch (error) {
      if (
        this.pending.get(entry.payload.requestId) === entry &&
        entry.resolutionState === 'resolving'
      ) {
        entry.resolutionState = 'pending';
      }
      logger.warn(
        '[diff-review-late-decision]',
        safeDiagnostic({
          event: 'diff-review-late-decision',
          runId: getProcessRunId(),
          requestId: entry.payload.requestId,
          sourceSessionId: entry.sourceSessionId,
          ownerSessionId: entry.ownerSessionId,
          outcome: 'failed',
          error: safeErrorSummary(error),
        }),
      );
    }
  }

  private emitCancelled(entry: PendingMcpDiffReview): void {
    this.deps.ingest({
      sessionId: entry.ownerSessionId,
      agentId: entry.agentId,
      kind: 'waiting-for-user',
      payload: { type: 'diff-review-cancelled', requestId: entry.payload.requestId },
      ts: Date.now(),
      source: 'sdk',
    });
  }

  private emitCancelledForOwner(
    entry: PendingMcpDiffReview,
    sessionId: string,
    agentId: string,
  ): void {
    try {
      this.deps.ingest({
        sessionId,
        agentId,
        kind: 'waiting-for-user',
        payload: { type: 'diff-review-cancelled', requestId: entry.payload.requestId },
        ts: Date.now(),
        source: 'sdk',
      });
    } catch {
      // The source projection may already be gone; successor hydration remains authoritative.
    }
  }

  private emitCancelledIfPossible(entry: PendingMcpDiffReview): void {
    try {
      this.emitCancelled(entry);
    } catch {
      // The owning session may have been deleted while the review was pending.
    }
  }
}

export const diffReviewService = new DiffReviewService();

eventBus.on('session-upserted', (session) => {
  if (session.lifecycle === 'closed') diffReviewService.cancelForSession(session.id);
});

eventBus.on('session-removed', (sessionId) => {
  diffReviewService.cancelForSession(sessionId, { emitCancelled: false });
});

eventBus.on('session-hand-off-committed', ({ sourceSessionId, successorSessionId }) => {
  diffReviewService.rehomeForHandOff(sourceSessionId, successorSessionId);
});
