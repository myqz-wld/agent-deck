import {
  MCP_PLAN_PRESENTATION_SCHEMA,
  parseMcpPresentationDisplay,
} from '@contracts/index';
import type {
  RemoteHostPlanReviewAcceptedDto,
  RemoteHostPlanReviewAskDto,
  RemoteHostPlanReviewFeedbackDto,
  RemoteHostPlanReviewSessionDto,
  RemoteHostPlanReviewTargetDto,
} from '@shared/remote-host';

import {
  parseRemoteHostPlanReviewAccepted,
  parseRemoteHostPlanReviewFeedback,
  parseRemoteHostPlanReviewSession,
} from './business-validation-plan-review';
import { parseRemoteHostPendingListResult } from './business-validation';
import { RemoteHostPublicError } from './errors';
import {
  REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
  REMOTE_HOST_PLAN_REVIEW_DEADLINE_MS,
  type RemoteHostScopedClient,
  type RemoteHostScopedRequest,
} from './service-scope';

type MutationId = (operation: string, profileId: string, intentId: string) => string;

/** Main-owned authority fence around Core-native Remote plan companion review operations. */
export class RemoteHostPlanReviewController {
  constructor(
    private readonly requestScoped: RemoteHostScopedRequest,
    private readonly assertScope: (scope: RemoteHostScopedClient) => void,
    private readonly mutationId: MutationId,
  ) {}

  start(request: RemoteHostPlanReviewTargetDto): Promise<RemoteHostPlanReviewSessionDto> {
    return this.run(request, 'plan.review.start', async (scope, revision) => {
      const value = await scope.client.request(
        'plan.review.start',
        { sessionId: request.sessionId, requestId: request.requestId },
        this.options(request, 'plan-review-start', revision),
      );
      return parseRemoteHostPlanReviewSession(value);
    });
  }

  ask(request: RemoteHostPlanReviewAskDto): Promise<RemoteHostPlanReviewAcceptedDto> {
    return this.run(request, 'plan.review.ask', async (scope, revision) => {
      const value = await scope.client.request(
        'plan.review.ask',
        { sessionId: request.sessionId, requestId: request.requestId, question: request.question },
        this.options(request, 'plan-review-ask', revision),
      );
      return parseRemoteHostPlanReviewAccepted(value);
    });
  }

  feedback(request: RemoteHostPlanReviewTargetDto): Promise<RemoteHostPlanReviewFeedbackDto> {
    return this.run(
      request,
      'plan.review.feedback',
      async (scope, revision) => {
        const value = await scope.client.request(
          'plan.review.feedback',
          { sessionId: request.sessionId, requestId: request.requestId },
          this.options(request, 'plan-review-feedback', revision),
        );
        return parseRemoteHostPlanReviewFeedback(value);
      },
    );
  }

  private run<T>(
    request: RemoteHostPlanReviewTargetDto,
    method: 'plan.review.start' | 'plan.review.ask' | 'plan.review.feedback',
    invoke: (scope: RemoteHostScopedClient, revision: number) => Promise<T>,
  ): Promise<T> {
    return this.requestScoped(request.profileId, method, async (scope) => {
      const revision = await this.authoritativeRevision(scope, request);
      this.assertScope(scope);
      return invoke(scope, revision);
    }, ['pending.list']);
  }

  private async authoritativeRevision(
    scope: RemoteHostScopedClient,
    request: RemoteHostPlanReviewTargetDto,
  ): Promise<number> {
    const value = await scope.client.request(
      'pending.list',
      { sessionId: request.sessionId },
      { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
    );
    this.assertScope(scope);
    const pending = parseRemoteHostPendingListResult(value, request.sessionId);
    if (pending.revision !== request.expectedRevision) {
      throw new RemoteHostPublicError('conflict', '远程数据已变化，请刷新后重试。');
    }
    const current = pending.requests.find((item) => item.id === request.requestId);
    if (!current) throw new RemoteHostPublicError('not_found', '计划展示不存在。');
    if (current.status !== 'pending') {
      throw new RemoteHostPublicError('already_decided', '计划展示已经结束。');
    }
    let display: ReturnType<typeof parseMcpPresentationDisplay>;
    try { display = parseMcpPresentationDisplay(current.display); }
    catch { display = null; }
    if (
      current.kind !== 'exit-plan' || !display ||
      display.schema !== MCP_PLAN_PRESENTATION_SCHEMA
    ) throw new RemoteHostPublicError('invalid_request', '当前请求不是可审阅的计划展示。');
    return pending.revision;
  }

  private options(
    request: RemoteHostPlanReviewTargetDto,
    operation: string,
    expectedRevision: number,
  ): { deadlineMs: number; idempotencyKey: string; expectedRevision: number } {
    return {
      deadlineMs: REMOTE_HOST_PLAN_REVIEW_DEADLINE_MS,
      idempotencyKey: this.mutationId(operation, request.profileId, request.intentId),
      expectedRevision,
    };
  }
}
