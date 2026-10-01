import type { JsonValue, PendingRequestDto } from '@contracts/index';
import type {
  RequestDiffReviewArgs,
  RequestDiffReviewResult,
  RequestPlanReviewArgs,
  RequestPlanReviewResult,
} from '@main/agent-deck-mcp/tools/schemas';
import type { PlanDeepReviewSession } from '@shared/types';
import type { AskUserArgs, AskUserResult } from '@main/agent-deck-mcp/tools/schemas/ask-user';

export interface ServerCoreMcpPresentationTransferLease {
  commit(): void;
  rollback(): void;
}

export interface ServerCoreMcpPresentationPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  requestPlan(sessionId: string, args: RequestPlanReviewArgs): Promise<RequestPlanReviewResult>;
  requestDiff(sessionId: string, args: RequestDiffReviewArgs): Promise<RequestDiffReviewResult>;
  requestAsk(sessionId: string, args: AskUserArgs, signal?: AbortSignal): Promise<AskUserResult>;
  startReview(
    sessionId: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<PlanDeepReviewSession>;
  askReview(
    sessionId: string,
    requestId: string,
    question: string,
    signal?: AbortSignal,
  ): Promise<void>;
  generateReviewFeedback(
    sessionId: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<string>;
  list(sessionId: string): PendingRequestDto[];
  respond(
    sessionId: string,
    requestId: string,
    action: string,
    value?: JsonValue,
  ): 'denied' | 'resolved' | null;
  releaseSession(sessionId: string, reason?: string): void;
  renameSession(fromSessionId: string, toSessionId: string): void;
  prepareSessionTransfer(
    fromSessionId: string,
    toSessionId: string,
  ): ServerCoreMcpPresentationTransferLease;
}
