import { isJsonObject, MCP_PRESENTATION_MAX_FEEDBACK_LENGTH } from '@contracts/index';
import type {
  RemoteHostPlanReviewAcceptedDto,
  RemoteHostPlanReviewFeedbackDto,
  RemoteHostPlanReviewSessionDto,
} from '@shared/remote-host';

import { RemoteHostInputError } from './input-validation';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const CONTROL = /[\u0000\u007f-\u009f\u2028\u2029]/u;

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!isJsonObject(value)) throw new RemoteHostInputError('planReview', 'invalid host result');
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RemoteHostInputError('planReview', 'invalid host result shape');
  }
  return value;
}

function token(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || !TOKEN.test(value)) {
    throw new RemoteHostInputError(field, 'invalid host result token');
  }
  return value;
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RemoteHostInputError('planReview.revision', 'invalid host result revision');
  }
  return value as number;
}

export function parseRemoteHostPlanReviewSession(
  value: unknown,
): RemoteHostPlanReviewSessionDto {
  const raw = object(value, ['agentId', 'revision', 'sessionId']);
  if (!['claude-code', 'codex-cli', 'grok-build'].includes(String(raw.agentId))) {
    throw new RemoteHostInputError('planReview.agentId', 'invalid host result adapter');
  }
  return {
    sessionId: token(raw.sessionId, 'planReview.sessionId'),
    agentId: raw.agentId as RemoteHostPlanReviewSessionDto['agentId'],
    revision: revision(raw.revision),
  };
}

export function parseRemoteHostPlanReviewAccepted(
  value: unknown,
): RemoteHostPlanReviewAcceptedDto {
  const raw = object(value, ['accepted', 'revision']);
  if (raw.accepted !== true) {
    throw new RemoteHostInputError('planReview.accepted', 'invalid host result acceptance');
  }
  return { accepted: true, revision: revision(raw.revision) };
}

export function parseRemoteHostPlanReviewFeedback(
  value: unknown,
): RemoteHostPlanReviewFeedbackDto {
  const raw = object(value, ['feedback', 'revision']);
  if (
    typeof raw.feedback !== 'string' || raw.feedback.length === 0 ||
    new TextEncoder().encode(raw.feedback).byteLength > MCP_PRESENTATION_MAX_FEEDBACK_LENGTH * 4 ||
    CONTROL.test(raw.feedback)
  ) throw new RemoteHostInputError('planReview.feedback', 'invalid host result feedback');
  return { feedback: raw.feedback, revision: revision(raw.revision) };
}
