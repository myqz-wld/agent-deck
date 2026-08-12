import type {
  RemoteHostPlanReviewAskDto,
  RemoteHostPlanReviewTargetDto,
} from '@shared/remote-host';

import {
  parseRemoteHostMutationAuthority,
  RemoteHostInputError,
} from './input-validation';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const CONTROL = /[\u0000\u007f-\u009f\u2028\u2029]/u;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemoteHostInputError('planReview', 'must be an object');
  }
  return value as Record<string, unknown>;
}

function exact(raw: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(raw).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new RemoteHostInputError('planReview', 'contains unexpected fields');
  }
}

function token(value: unknown, field: string, maximum = 256): string {
  if (
    typeof value !== 'string' || value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maximum || !TOKEN.test(value)
  ) throw new RemoteHostInputError(field, 'invalid token');
  return value;
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RemoteHostInputError('expectedRevision', 'must be a non-negative safe integer');
  }
  return value as number;
}

function target(raw: Record<string, unknown>): RemoteHostPlanReviewTargetDto {
  return {
    profileId: token(raw.profileId, 'profileId', 128),
    sessionId: token(raw.sessionId, 'sessionId'),
    requestId: token(raw.requestId, 'requestId'),
    expectedAuthority: parseRemoteHostMutationAuthority(raw.expectedAuthority),
    intentId: token(raw.intentId, 'intentId', 128),
    expectedRevision: revision(raw.expectedRevision),
  };
}

export function parseRemoteHostPlanReviewTarget(
  value: unknown,
): RemoteHostPlanReviewTargetDto {
  const raw = object(value);
  exact(raw, [
    'expectedAuthority', 'expectedRevision', 'intentId', 'profileId', 'requestId', 'sessionId',
  ]);
  return target(raw);
}

export function parseRemoteHostPlanReviewAsk(value: unknown): RemoteHostPlanReviewAskDto {
  const raw = object(value);
  exact(raw, [
    'expectedAuthority', 'expectedRevision', 'intentId', 'profileId', 'question', 'requestId',
    'sessionId',
  ]);
  if (
    typeof raw.question !== 'string' || raw.question.trim().length === 0 ||
    new TextEncoder().encode(raw.question).byteLength > 64 * 1024 || CONTROL.test(raw.question)
  ) throw new RemoteHostInputError('question', 'invalid or too long');
  return { ...target(raw), question: raw.question };
}
