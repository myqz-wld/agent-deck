import { createHash } from 'node:crypto';

import {
  AgentDeckClientErrorCode,
  isCoreMethodGranted,
  isJsonValue,
  type CoreMethod,
  type JsonObject,
  type JsonValue,
} from '@contracts/index';
import {
  DaemonRequestError,
  type DaemonCoreRuntime,
  type DaemonEventSubscriptionInput,
  type DaemonRequestInput,
  type DaemonRequestResult,
} from '@hosts/daemon';

import type { ServerCoreMcpPresentationPort } from './mcp-presentation-port';
import type {
  ServerCoreMutationClaim,
  ServerCoreMutationIdentity,
} from './runtime-metadata-store';
import { canonicalJson } from './runtime-validation';

export const SERVER_CORE_PLAN_REVIEW_METHODS = Object.freeze([
  'plan.review.start',
  'plan.review.ask',
  'plan.review.feedback',
] as const satisfies readonly CoreMethod[]);

type PlanReviewMethod = (typeof SERVER_CORE_PLAN_REVIEW_METHODS)[number];

interface PlanReviewTarget {
  sessionId: string;
  requestId: string;
}

export interface ServerCorePlanReviewMetadataPort {
  claimMutation(
    identity: ServerCoreMutationIdentity,
    now?: number,
    expectedRevision?: number,
  ): ServerCoreMutationClaim;
  appendChange(kind: string, entityId: string | null, payload: JsonValue): number;
  completeMutation(identity: ServerCoreMutationIdentity, result: JsonValue, revision: number): void;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;

function planReviewMethod(method: CoreMethod): method is PlanReviewMethod {
  return (SERVER_CORE_PLAN_REVIEW_METHODS as readonly CoreMethod[]).includes(method);
}

function invalid(): never {
  throw new DaemonRequestError(
    AgentDeckClientErrorCode.InvalidRequest,
    'Plan review request is invalid',
  );
}

function token(value: unknown): string {
  if (
    typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 256 ||
    !TOKEN.test(value)
  ) invalid();
  return value;
}

function target(params: JsonObject, withQuestion = false): PlanReviewTarget & { question?: string } {
  const expected = withQuestion
    ? ['question', 'requestId', 'sessionId']
    : ['requestId', 'sessionId'];
  const actual = Object.keys(params).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid();
  }
  const base = { sessionId: token(params.sessionId), requestId: token(params.requestId) };
  if (!withQuestion) return base;
  if (
    typeof params.question !== 'string' || params.question.length === 0 ||
    Buffer.byteLength(params.question) > 64 * 1024 || CONTROL.test(params.question)
  ) invalid();
  return { ...base, question: params.question };
}

function replay(claim: ServerCoreMutationClaim): DaemonRequestResult | null {
  if (claim.state === 'claimed') return null;
  if (claim.state === 'conflict') {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.Conflict,
      'Plan review revision or idempotency does not match',
    );
  }
  if (claim.state === 'uncertain') {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.ProviderLost,
      'The earlier plan review outcome is uncertain',
    );
  }
  if (!isJsonValue(claim.result)) throw new Error('Stored plan review result is invalid');
  return { result: claim.result, revision: claim.revision };
}

/** Adds Remote-owner Core companion review operations around pending plan presentations. */
export class ServerCorePlanReviewRuntime implements DaemonCoreRuntime {
  readonly supportedMethods: readonly CoreMethod[];
  readonly subscribe?: DaemonCoreRuntime['subscribe'];

  constructor(
    private readonly base: DaemonCoreRuntime,
    private readonly presentations: Pick<
      ServerCoreMcpPresentationPort,
      'startReview' | 'askReview' | 'generateReviewFeedback'
    >,
    private readonly metadata: ServerCorePlanReviewMetadataPort,
  ) {
    this.supportedMethods = Object.freeze([
      ...new Set([...base.supportedMethods, ...SERVER_CORE_PLAN_REVIEW_METHODS]),
    ]);
    if (base.subscribe) {
      const subscribe = base.subscribe.bind(base);
      this.subscribe = (input: DaemonEventSubscriptionInput) => subscribe(input);
    }
  }

  start(): Promise<void> { return this.base.start(); }
  stop(reason: string): Promise<void> { return this.base.stop(reason); }
  currentRevision(...args: Parameters<DaemonCoreRuntime['currentRevision']>): Promise<number> | number {
    return this.base.currentRevision(...args);
  }

  async execute(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    if (!planReviewMethod(input.method)) return this.base.execute(input);
    if (!isCoreMethodGranted(input.access, input.method)) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'Request rejected');
    }
    if (input.signal.aborted) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request was cancelled');
    }
    const params = target(input.params, input.method === 'plan.review.ask');
    return this.mutate(input, params, async (): Promise<JsonObject> => {
      switch (input.method) {
        case 'plan.review.start': {
          const child = await this.presentations.startReview(
            params.sessionId,
            params.requestId,
            input.signal,
          );
          return { sessionId: child.sessionId, agentId: child.agentId };
        }
        case 'plan.review.ask':
          await this.presentations.askReview(
            params.sessionId,
            params.requestId,
            params.question!,
            input.signal,
          );
          return { accepted: true };
        case 'plan.review.feedback': {
          const feedback = await this.presentations.generateReviewFeedback(
            params.sessionId,
            params.requestId,
            input.signal,
          );
          return { feedback };
        }
      }
      throw new Error('Unsupported plan review method');
    });
  }

  private async mutate(
    input: DaemonRequestInput,
    params: PlanReviewTarget,
    invoke: () => Promise<JsonObject>,
  ): Promise<DaemonRequestResult> {
    const identity: ServerCoreMutationIdentity = {
      connectionScope: input.access.connectionScope,
      accessSurface: input.access.surface,
      idempotencyKey: input.idempotencyKey!,
      method: input.method,
      requestFingerprint: createHash('sha256')
        .update(`${input.method}\u0000${canonicalJson(input.params)}`)
        .digest('hex'),
    };
    const prior = replay(this.metadata.claimMutation(
      identity,
      Date.now(),
      input.expectedRevision ?? undefined,
    ));
    if (prior) return prior;
    const value = await invoke();
    const revision = this.metadata.appendChange(input.method, params.sessionId, {
      requestId: params.requestId,
      sessionId: params.sessionId,
    });
    const result = { ...value, revision };
    if (!isJsonValue(result)) throw new Error('Plan review result is invalid');
    this.metadata.completeMutation(identity, result, revision);
    return { result, revision };
  }
}
