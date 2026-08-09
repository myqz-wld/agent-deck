import { describe, expect, it, vi } from 'vitest';

import type {
  AuthenticatedClientAccessContext,
  CoreMethod,
  JsonObject,
  JsonValue,
} from '@contracts/index';
import type { DaemonCoreRuntime, DaemonRequestInput } from '@hosts/daemon';

import { ServerCorePlanReviewRuntime } from './plan-review-runtime';
import type {
  ServerCoreMutationClaim,
  ServerCoreMutationIdentity,
} from './runtime-metadata-store';

const desktop: AuthenticatedClientAccessContext = {
  kind: 'authenticated-client',
  topology: 'server-core',
  instanceId: 'instance-a',
  clientId: 'desktop-a',
  transport: 'ssh',
  accessCredentialId: 'credential-a',
  authority: 'owner-equivalent',
  surface: 'desktop-full',
};

function request(
  method: CoreMethod,
  params: JsonObject,
  access: AuthenticatedClientAccessContext = desktop,
): DaemonRequestInput {
  return {
    access,
    requestId: `request-${method}`,
    method,
    params,
    idempotencyKey: `intent-${method}`,
    expectedRevision: 7,
    deadlineAt: null,
    signal: new AbortController().signal,
  };
}

function harness() {
  let revision = 7;
  const claims = new Map<string, { identity: ServerCoreMutationIdentity; result?: JsonValue; revision?: number }>();
  const metadata = {
    claimMutation: vi.fn((identity: ServerCoreMutationIdentity, _now: number, expected?: number): ServerCoreMutationClaim => {
      const current = claims.get(identity.idempotencyKey);
      if (current) {
        if (
          current.identity.method !== identity.method ||
          current.identity.requestFingerprint !== identity.requestFingerprint
        ) return { state: 'conflict' };
        if (current.result === undefined || current.revision === undefined) return { state: 'uncertain' };
        return { state: 'completed', result: current.result, revision: current.revision };
      }
      if (expected !== revision) return { state: 'conflict' };
      claims.set(identity.idempotencyKey, { identity });
      return { state: 'claimed' };
    }),
    appendChange: vi.fn((_kind: string, _entityId: string | null, _payload: JsonValue) => ++revision),
    completeMutation: vi.fn((identity: ServerCoreMutationIdentity, result: JsonValue, resultRevision: number) => {
      const row = claims.get(identity.idempotencyKey);
      if (!row) throw new Error('missing claim');
      row.result = result;
      row.revision = resultRevision;
    }),
  };
  const startReview = vi.fn(async () => ({ sessionId: 'review-child', agentId: 'codex-cli' as const }));
  const askReview = vi.fn(async () => undefined);
  const generateReviewFeedback = vi.fn(async () => 'Add a rollback test.');
  const base = {
    supportedMethods: ['system.health'],
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    currentRevision: () => revision,
    execute: vi.fn(async () => ({ result: { ok: true }, revision })),
  } as unknown as DaemonCoreRuntime;
  const runtime = new ServerCorePlanReviewRuntime(base, {
    startReview,
    askReview,
    generateReviewFeedback,
  }, metadata);
  return { askReview, base, generateReviewFeedback, metadata, runtime, startReview };
}

describe('ServerCorePlanReviewRuntime', () => {
  it('exposes desktop-only revision-bound plan review operations with replay', async () => {
    const state = harness();
    expect(state.runtime.supportedMethods).toContain('plan.review.start');
    const input = request('plan.review.start', {
      sessionId: 'session-a', requestId: 'mcp-exit-plan-request-a',
    });
    const first = await state.runtime.execute(input);
    await expect(state.runtime.execute(input)).resolves.toEqual(first);
    expect(first).toEqual({
      result: { sessionId: 'review-child', agentId: 'codex-cli', revision: 8 },
      revision: 8,
    });
    expect(state.startReview).toHaveBeenCalledOnce();
    expect(state.metadata.appendChange).toHaveBeenCalledWith(
      'plan.review.start',
      'session-a',
      { sessionId: 'session-a', requestId: 'mcp-exit-plan-request-a' },
    );
  });

  it('validates exact bounded input and denies the Feishu surface', async () => {
    const state = harness();
    await expect(state.runtime.execute(request('plan.review.ask', {
      sessionId: 'session-a', requestId: 'request-a', question: 'Review races', extra: true,
    }))).rejects.toMatchObject({ code: 'invalid_request' });

    const feishu = { ...desktop, clientId: 'feishu-a', transport: 'feishu' as const,
      surface: 'feishu-session-console' as const };
    await expect(state.runtime.execute(request('plan.review.feedback', {
      sessionId: 'session-a', requestId: 'request-a',
    }, feishu))).rejects.toMatchObject({ code: 'access_denied' });
    expect(state.askReview).not.toHaveBeenCalled();
    expect(state.generateReviewFeedback).not.toHaveBeenCalled();
  });
});
