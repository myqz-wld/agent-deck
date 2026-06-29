import { randomUUID } from 'node:crypto';
import type { DiffReviewRequest, DiffReviewResponse } from '@shared/types';
import { eventBus } from '@main/event-bus';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';

export type McpDiffReviewDecision =
  | { decision: 'approved' }
  | { decision: 'revise'; feedback?: string }
  | { decision: 'timeout' };

interface PendingMcpDiffReview {
  payload: DiffReviewRequest;
  sessionId: string;
  agentId: string;
  timer: NodeJS.Timeout | null;
  resolve: (decision: McpDiffReviewDecision) => void;
}

interface RequestDiffReviewInput extends Omit<DiffReviewRequest, 'type' | 'requestId'> {
  sessionId: string;
  agentId: string;
  timeoutMs?: number;
}

class DiffReviewService {
  private readonly pending = new Map<string, PendingMcpDiffReview>();

  request(input: RequestDiffReviewInput): Promise<McpDiffReviewDecision> {
    const requestId = `mcp-diff-${randomUUID()}`;
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
      sessionId: input.sessionId,
      agentId: input.agentId,
      timer: null,
      resolve: resolveDecision,
    };
    if (input.timeoutMs && input.timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        this.emitCancelledIfPossible(entry);
        resolveDecision({ decision: 'timeout' });
      }, input.timeoutMs);
    }
    this.pending.set(requestId, entry);

    try {
      sessionManager.ingest({
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
      if (entry.sessionId !== sessionId) continue;
      if (!this.pending.delete(entry.payload.requestId)) continue;
      if (entry.timer) clearTimeout(entry.timer);
      if (emitCancelled) this.emitCancelledIfPossible(entry);
      entry.resolve({ decision: 'timeout' });
      cancelled += 1;
    }
    return cancelled;
  }

  respond(sessionId: string, requestId: string, response: DiffReviewResponse): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.sessionId !== sessionId) return false;
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
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => entry.payload);
  }

  listAllPending(agentId?: string): Record<string, DiffReviewRequest[]> {
    const out: Record<string, DiffReviewRequest[]> = {};
    for (const entry of this.pending.values()) {
      if (agentId && entry.agentId !== agentId) continue;
      const session = sessionRepo.get(entry.sessionId);
      if (!session || session.lifecycle === 'closed') continue;
      (out[entry.sessionId] ??= []).push(entry.payload);
    }
    return out;
  }

  private emitCancelled(entry: PendingMcpDiffReview): void {
    sessionManager.ingest({
      sessionId: entry.sessionId,
      agentId: entry.agentId,
      kind: 'waiting-for-user',
      payload: { type: 'diff-review-cancelled', requestId: entry.payload.requestId },
      ts: Date.now(),
      source: 'sdk',
    });
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
