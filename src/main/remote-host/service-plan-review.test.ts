import { describe, expect, it, vi } from 'vitest';

import { MCP_PLAN_PRESENTATION_SCHEMA } from '@contracts/index';
import type { RemoteHostPlanReviewTargetDto } from '@shared/remote-host';

import { RemoteHostPlanReviewController } from './service-plan-review';
import type { RemoteHostScopedClient, RemoteHostScopedRequest } from './service-scope';

const target: RemoteHostPlanReviewTargetDto = {
  profileId: 'profile-a',
  sessionId: 'session-a',
  requestId: 'mcp-exit-plan-request-a',
  expectedRevision: 10,
  intentId: 'intent-a',
};

function pending(overrides: Record<string, unknown> = {}) {
  return {
    requests: [{
      id: target.requestId,
      sessionId: target.sessionId,
      kind: 'exit-plan',
      status: 'pending',
      createdAt: 1,
      expiresAt: null,
      display: { schema: MCP_PLAN_PRESENTATION_SCHEMA, plan: '# Plan' },
      ...overrides,
    }],
    revision: 10,
  };
}

function harness(results: unknown[]) {
  const request = vi.fn();
  for (const result of results) request.mockResolvedValueOnce(result);
  const scope = {
    profileId: 'profile-a',
    profileEpoch: 1,
    sourceEpoch: 1,
    client: { request },
  } as unknown as RemoteHostScopedClient;
  const scopedCalls: Array<{ profileId: string; method: string; additional?: readonly string[] }> = [];
  const requestScoped = (async <T>(
    profileId: string,
    method: string,
    run: (value: RemoteHostScopedClient) => Promise<T>,
    additional?: readonly string[],
  ): Promise<T> => {
    scopedCalls.push({ profileId, method, additional });
    return run(scope);
  }) as RemoteHostScopedRequest;
  const assertScope = vi.fn();
  const mutationId = vi.fn((operation: string, profileId: string, intentId: string) =>
    `electron:${operation}:${profileId}:${intentId}`);
  return {
    assertScope,
    controller: new RemoteHostPlanReviewController(requestScoped, assertScope, mutationId),
    mutationId,
    request,
    scopedCalls,
  };
}

describe('RemoteHostPlanReviewController', () => {
  it('rereads the authoritative plan before creating the Core-owned companion', async () => {
    const state = harness([
      pending(),
      { sessionId: 'review-child', agentId: 'codex-cli', revision: 11 },
    ]);
    await expect(state.controller.start(target)).resolves.toEqual({
      sessionId: 'review-child', agentId: 'codex-cli', revision: 11,
    });
    expect(state.scopedCalls).toEqual([{
      profileId: 'profile-a',
      method: 'plan.review.start',
      additional: ['pending.list'],
    }]);
    expect(state.request.mock.calls).toEqual([
      ['pending.list', { sessionId: 'session-a' }, { deadlineMs: 45_000 }],
      [
        'plan.review.start',
        { sessionId: 'session-a', requestId: 'mcp-exit-plan-request-a' },
        {
          deadlineMs: 315_000,
          expectedRevision: 10,
          idempotencyKey: 'electron:plan-review-start:profile-a:intent-a',
        },
      ],
    ]);
    expect(state.assertScope).toHaveBeenCalledTimes(2);
  });

  it('sends questions and feedback only after the same authority fence', async () => {
    const ask = harness([pending(), { accepted: true, revision: 11 }]);
    await expect(ask.controller.ask({ ...target, question: 'Check the teardown race.' }))
      .resolves.toEqual({ accepted: true, revision: 11 });
    expect(ask.request.mock.calls[1]?.[0]).toBe('plan.review.ask');
    expect(ask.request.mock.calls[1]?.[1]).toEqual({
      sessionId: 'session-a',
      requestId: 'mcp-exit-plan-request-a',
      question: 'Check the teardown race.',
    });

    const feedback = harness([pending(), { feedback: 'Add a bounded rollback test.', revision: 11 }]);
    await expect(feedback.controller.feedback(target)).resolves.toEqual({
      feedback: 'Add a bounded rollback test.', revision: 11,
    });
    expect(feedback.request.mock.calls[1]?.[0]).toBe('plan.review.feedback');
  });

  it('never calls a review method for a stale revision or non-plan pending row', async () => {
    const stale = harness([{ ...pending(), revision: 11 }]);
    await expect(stale.controller.start(target)).rejects.toMatchObject({ code: 'conflict' });
    expect(stale.request).toHaveBeenCalledOnce();

    const wrongKind = harness([pending({ kind: 'permission', display: {} })]);
    await expect(wrongKind.controller.start(target)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(wrongKind.request).toHaveBeenCalledOnce();
  });
});
