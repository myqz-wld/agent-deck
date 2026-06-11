import { randomUUID } from 'node:crypto';
import type { ExitPlanModeRequest, ExitPlanModeResponse } from '@shared/types';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';

export type McpPlanReviewDecision =
  | { decision: 'approved' }
  | { decision: 'revise'; feedback?: string }
  | { decision: 'timeout' };

interface PendingMcpPlanReview {
  payload: ExitPlanModeRequest;
  sessionId: string;
  agentId: string;
  timer: NodeJS.Timeout | null;
  resolve: (decision: McpPlanReviewDecision) => void;
}

interface RequestPlanReviewInput {
  sessionId: string;
  agentId: string;
  plan: string;
  title?: string;
  timeoutMs?: number;
}

class PlanReviewService {
  private readonly pending = new Map<string, PendingMcpPlanReview>();

  request(input: RequestPlanReviewInput): Promise<McpPlanReviewDecision> {
    const requestId = `mcp-plan-${randomUUID()}`;
    const payload: ExitPlanModeRequest = {
      type: 'exit-plan-mode',
      requestId,
      reviewSource: 'mcp',
      ...(input.title ? { title: input.title } : {}),
      plan: input.plan,
    };

    const createdAt = Date.now();
    let resolveDecision: (decision: McpPlanReviewDecision) => void = () => {};
    const promise = new Promise<McpPlanReviewDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const entry: PendingMcpPlanReview = {
      payload,
      sessionId: input.sessionId,
      agentId: input.agentId,
      timer: null,
      resolve: resolveDecision,
    };
    if (input.timeoutMs && input.timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        this.emitCancelled(entry);
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

  respond(sessionId: string, requestId: string, response: ExitPlanModeResponse): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.sessionId !== sessionId) return false;
    this.pending.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    if (response.decision === 'keep-planning') {
      entry.resolve({
        decision: 'revise',
        ...(response.feedback?.trim() ? { feedback: response.feedback.trim() } : {}),
      });
    } else {
      entry.resolve({ decision: 'approved' });
    }
    return true;
  }

  listPending(sessionId: string): ExitPlanModeRequest[] {
    return [...this.pending.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => entry.payload);
  }

  listAllPending(agentId?: string): Record<string, ExitPlanModeRequest[]> {
    const out: Record<string, ExitPlanModeRequest[]> = {};
    for (const entry of this.pending.values()) {
      if (agentId && entry.agentId !== agentId) continue;
      const session = sessionRepo.get(entry.sessionId);
      if (!session || session.lifecycle === 'closed') continue;
      (out[entry.sessionId] ??= []).push(entry.payload);
    }
    return out;
  }

  private emitCancelled(entry: PendingMcpPlanReview): void {
    sessionManager.ingest({
      sessionId: entry.sessionId,
      agentId: entry.agentId,
      kind: 'waiting-for-user',
      payload: { type: 'exit-plan-cancelled', requestId: entry.payload.requestId },
      ts: Date.now(),
      source: 'sdk',
    });
  }
}

export const planReviewService = new PlanReviewService();
