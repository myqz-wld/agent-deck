import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  SessionRecord,
} from '@shared/types';
import { eventBus } from '@main/event-bus';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import log from '@main/utils/logger';
import {
  planReviewSessionCoordinator,
  type PlanReviewChildSession,
  type PlanReviewSessionCoordinator,
} from './deep-review-session';

export type McpPlanReviewDecision =
  | { decision: 'approved' }
  | { decision: 'revise'; feedback?: string }
  | { decision: 'timeout' };

type PendingState = 'active' | 'timed-out';
type ResolutionState = 'pending' | 'resolving' | 'resolved' | 'cancelled';

interface PendingMcpPlanReview {
  payload: ExitPlanModeRequest;
  sessionId: string;
  agentId: string;
  state: PendingState;
  timer: NodeJS.Timeout | null;
  resolve: (decision: McpPlanReviewDecision) => void;
  resolutionState: ResolutionState;
  lateDecisionResponse: ExitPlanModeResponse | null;
  child: PlanReviewChildSession | null;
  childPromise: Promise<PlanReviewChildSession> | null;
  childClosePromise: Promise<void> | null;
  autoFeedbackPromise: Promise<string> | null;
}

export interface RequestPlanReviewInput {
  sessionId: string;
  agentId: string;
  plan: string;
  title?: string;
  timeoutMs?: number;
}

export interface PlanReviewServiceDependencies {
  createRequestId: () => string;
  ingest: (event: AgentEvent) => void;
  getSession: (sessionId: string) => SessionRecord | null;
  coordinator: PlanReviewSessionCoordinator;
}

const productionDependencies: PlanReviewServiceDependencies = {
  createRequestId: () => `mcp-plan-${randomUUID()}`,
  ingest: (event) => sessionManager.ingest(event),
  getSession: (sessionId) => sessionRepo.get(sessionId),
  coordinator: planReviewSessionCoordinator,
};

const logger = log.scope('plan-review-service');

function normalizeResponse(response: ExitPlanModeResponse): McpPlanReviewDecision {
  if (response.decision !== 'keep-planning') return { decision: 'approved' };
  const feedback = response.feedback?.trim();
  return {
    decision: 'revise',
    ...(feedback ? { feedback } : {}),
  };
}

function lateDecisionSignature(response: ExitPlanModeResponse): string {
  if (response.decision === 'approve') return `approve:${response.targetMode}`;
  if (response.decision === 'approve-bypass') return 'approve-bypass';
  return `keep-planning:${response.feedback?.trim() ?? ''}`;
}

function wasCancelledDuringResolution(entry: PendingMcpPlanReview): boolean {
  return entry.resolutionState === 'cancelled';
}

export class PlanReviewService {
  private readonly pending = new Map<string, PendingMcpPlanReview>();

  constructor(private readonly deps: PlanReviewServiceDependencies = productionDependencies) {}

  request(input: RequestPlanReviewInput): Promise<McpPlanReviewDecision> {
    const requestId = this.deps.createRequestId();
    const payload: ExitPlanModeRequest = {
      type: 'exit-plan-mode',
      requestId,
      reviewSource: 'mcp',
      ...(input.title ? { title: input.title } : {}),
      plan: input.plan,
    };

    let resolveDecision: (decision: McpPlanReviewDecision) => void = () => {};
    const promise = new Promise<McpPlanReviewDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const entry: PendingMcpPlanReview = {
      payload,
      sessionId: input.sessionId,
      agentId: input.agentId,
      state: 'active',
      timer: null,
      resolve: resolveDecision,
      resolutionState: 'pending',
      lateDecisionResponse: null,
      child: null,
      childPromise: null,
      childClosePromise: null,
      autoFeedbackPromise: null,
    };
    if (input.timeoutMs && input.timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        const current = this.pending.get(requestId);
        if (current !== entry || current.state !== 'active') return;
        current.timer = null;
        current.state = 'timed-out';
        current.resolve({ decision: 'timeout' });
      }, input.timeoutMs);
    }
    this.pending.set(requestId, entry);

    try {
      this.deps.ingest({
        sessionId: input.sessionId,
        agentId: input.agentId,
        kind: 'waiting-for-user',
        payload,
        ts: Date.now(),
        source: 'sdk',
      });
    } catch (error) {
      this.pending.delete(requestId);
      if (entry.timer) clearTimeout(entry.timer);
      throw error;
    }
    return promise;
  }

  async startDeepReview(sessionId: string, requestId: string): Promise<PlanReviewChildSession> {
    const entry = this.requireEntry(sessionId, requestId);
    if (entry.child) return entry.child;
    if (entry.childPromise) return entry.childPromise;

    const childPromise = this.deps.coordinator.start({
      sourceSessionId: entry.sessionId,
      request: entry.payload,
    });
    entry.childPromise = childPromise;
    try {
      const child = await childPromise;
      if (this.pending.get(requestId) !== entry) {
        await this.deps.coordinator.close(child);
        throw new Error('The plan request was resolved while its review session was starting.');
      }
      entry.child = child;
      return child;
    } finally {
      if (this.pending.get(requestId) === entry) entry.childPromise = null;
    }
  }

  async askDeepReview(sessionId: string, requestId: string, question: string): Promise<void> {
    const text = question.trim();
    if (!text) throw new Error('A review question is required.');
    const child = await this.startDeepReview(sessionId, requestId);
    await this.deps.coordinator.ask(child, text);
  }

  async generateAndSubmitFeedback(sessionId: string, requestId: string): Promise<string> {
    const entry = this.requireEntry(sessionId, requestId);
    if (entry.autoFeedbackPromise) return entry.autoFeedbackPromise;
    const operation = this.generateAndSubmitFeedbackForEntry(entry);
    entry.autoFeedbackPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.pending.get(requestId) === entry) entry.autoFeedbackPromise = null;
    }
  }

  async respond(
    sessionId: string,
    requestId: string,
    response: ExitPlanModeResponse,
  ): Promise<boolean> {
    const entry = this.pending.get(requestId);
    if (!entry || entry.sessionId !== sessionId) return false;
    if (entry.resolutionState !== 'pending') {
      throw new Error('This plan decision is already being submitted or is no longer pending.');
    }
    if (entry.state === 'timed-out') {
      if (
        entry.lateDecisionResponse &&
        lateDecisionSignature(entry.lateDecisionResponse) !== lateDecisionSignature(response)
      ) {
        throw new Error('A late plan-decision retry must use the same decision as its first attempt.');
      }
      entry.lateDecisionResponse ??= { ...response };
    }
    entry.resolutionState = 'resolving';
    try {
      if (entry.state === 'timed-out') {
        await this.deps.coordinator.deliverLateDecision({
          sourceSessionId: entry.sessionId,
          request: entry.payload,
          response: entry.lateDecisionResponse!,
        });
      } else {
        entry.resolve(normalizeResponse(response));
      }
      if (wasCancelledDuringResolution(entry)) {
        await this.closeChild(entry);
        return false;
      }
      entry.resolutionState = 'resolved';
      this.removeEntry(entry);
      await this.closeChild(entry);
      return true;
    } catch (error) {
      if (entry.resolutionState === 'resolving') entry.resolutionState = 'pending';
      throw error;
    }
  }

  cancelForSession(
    sessionId: string,
    options: { emitCancelled?: boolean } = {},
  ): number {
    const emitCancelled = options.emitCancelled ?? true;
    let cancelled = 0;
    for (const entry of [...this.pending.values()]) {
      if (entry.sessionId !== sessionId) continue;
      if (entry.resolutionState === 'resolved' || entry.resolutionState === 'cancelled') continue;
      entry.resolutionState = 'cancelled';
      this.removeEntry(entry);
      if (emitCancelled) this.emitCancelledIfPossible(entry);
      if (entry.state === 'active') entry.resolve({ decision: 'timeout' });
      void this.closeChild(entry);
      cancelled += 1;
    }
    return cancelled;
  }

  rehomeForHandOff(sourceSessionId: string, successorSessionId: string): number {
    const movedEntries: Array<{
      entry: PendingMcpPlanReview;
      previousAgentId: string;
    }> = [];
    for (const entry of this.pending.values()) {
      if (entry.sessionId !== sourceSessionId) continue;
      const previousAgentId = entry.agentId;
      // Ownership commit is the authoritative boundary. Route the backend gate first so a
      // transient metadata/projection failure cannot leave it attached to the closing source.
      entry.sessionId = successorSessionId;
      movedEntries.push({ entry, previousAgentId });
    }
    if (movedEntries.length === 0) return 0;

    let successor: SessionRecord | null = null;
    try {
      successor = this.deps.getSession(successorSessionId);
    } catch (error) {
      logger.warn(
        `[plan-review] failed to read handoff successor metadata successor=${successorSessionId}; preserving the prior adapter projection`,
        error,
      );
    }

    for (const { entry, previousAgentId } of movedEntries) {
      entry.agentId = successor?.agentId ?? previousAgentId;

      try {
        this.deps.ingest({
          sessionId: sourceSessionId,
          agentId: previousAgentId,
          kind: 'waiting-for-user',
          payload: { type: 'exit-plan-cancelled', requestId: entry.payload.requestId },
          ts: Date.now(),
          source: 'sdk',
        });
      } catch (error) {
        logger.warn(
          `[plan-review] failed to remove handoff source card request=${entry.payload.requestId} source=${sourceSessionId}`,
          error,
        );
      }
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
        // The backend entry already belongs to the successor. Hydration can restore the card.
        logger.warn(
          `[plan-review] failed to add handoff successor card request=${entry.payload.requestId} successor=${successorSessionId}`,
          error,
        );
      }
    }
    return movedEntries.length;
  }

  listPending(sessionId: string): ExitPlanModeRequest[] {
    return [...this.pending.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => entry.payload);
  }

  listAllPending(agentId?: string): Record<string, ExitPlanModeRequest[]> {
    const out: Record<string, ExitPlanModeRequest[]> = {};
    for (const entry of this.pending.values()) {
      let session: SessionRecord | null;
      try {
        session = this.deps.getSession(entry.sessionId);
      } catch (error) {
        logger.warn(
          `[plan-review] failed to hydrate pending request=${entry.payload.requestId} session=${entry.sessionId}`,
          error,
        );
        continue;
      }
      if (!session || session.lifecycle === 'closed') continue;
      // A transient rehome lookup can retain the prior adapter projection. Heal it on the next
      // successful hydration so cross-adapter handoffs remain visible under the successor adapter.
      entry.agentId = session.agentId;
      if (agentId && entry.agentId !== agentId) continue;
      (out[entry.sessionId] ??= []).push(entry.payload);
    }
    return out;
  }

  private async generateAndSubmitFeedbackForEntry(entry: PendingMcpPlanReview): Promise<string> {
    const child = await this.startDeepReview(entry.sessionId, entry.payload.requestId);
    const feedback = await this.deps.coordinator.generateFeedback({
      child,
      request: entry.payload,
    });
    if (this.pending.get(entry.payload.requestId) !== entry) {
      throw new Error('The plan request was resolved before automatic feedback could be submitted.');
    }
    const submitted = await this.respond(entry.sessionId, entry.payload.requestId, {
      decision: 'keep-planning',
      feedback,
    });
    if (!submitted) throw new Error('The plan request is no longer pending.');
    return feedback;
  }

  private requireEntry(sessionId: string, requestId: string): PendingMcpPlanReview {
    const entry = this.pending.get(requestId);
    if (
      !entry ||
      entry.sessionId !== sessionId ||
      entry.resolutionState !== 'pending'
    ) {
      throw new Error('The plan review request is no longer pending.');
    }
    return entry;
  }

  private removeEntry(entry: PendingMcpPlanReview): void {
    if (this.pending.get(entry.payload.requestId) === entry) {
      this.pending.delete(entry.payload.requestId);
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
  }

  private async closeChild(entry: PendingMcpPlanReview): Promise<void> {
    if (!entry.child) return;
    if (!entry.childClosePromise) {
      const child = entry.child;
      entry.childClosePromise = this.deps.coordinator.close(child).catch((error) => {
        logger.warn(`[plan-review] failed to close child ${child.sessionId}`, error);
      });
    }
    await entry.childClosePromise;
  }

  private emitCancelled(entry: PendingMcpPlanReview): void {
    this.deps.ingest({
      sessionId: entry.sessionId,
      agentId: entry.agentId,
      kind: 'waiting-for-user',
      payload: { type: 'exit-plan-cancelled', requestId: entry.payload.requestId },
      ts: Date.now(),
      source: 'sdk',
    });
  }

  private emitCancelledIfPossible(entry: PendingMcpPlanReview): void {
    try {
      this.emitCancelled(entry);
    } catch {
      // The owning session may have been deleted while the review was pending.
    }
  }
}

export const planReviewService = new PlanReviewService();

eventBus.on('session-upserted', (session) => {
  if (session.lifecycle === 'closed') planReviewService.cancelForSession(session.id);
});

eventBus.on('session-hand-off-committed', ({ sourceSessionId, successorSessionId }) => {
  planReviewService.rehomeForHandOff(sourceSessionId, successorSessionId);
});

eventBus.on('session-removed', (sessionId) => {
  planReviewService.cancelForSession(sessionId, { emitCancelled: false });
});
