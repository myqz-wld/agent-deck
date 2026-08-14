import { isJsonObject, type JsonValue, type PendingRequestDto } from '@contracts/index';
import { parseRemoteHostAskQuestionDisplay } from '@shared/remote-host';
import { FeishuGatewayError } from './errors';
import type { FeishuPendingAction } from './types';

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/;

function boundedAnswer(value: unknown): boolean {
  if (typeof value === 'string') {
    return (
      value.length > 0 &&
      new TextEncoder().encode(value).byteLength <= 4_096 &&
      !CONTROL.test(value)
    );
  }
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 32 &&
    value.every(
      (item) =>
        typeof item === 'string' &&
        item.length > 0 &&
        new TextEncoder().encode(item).byteLength <= 4_096 &&
        !CONTROL.test(item),
    )
  );
}

function validateQuestionValue(request: PendingRequestDto, value: JsonValue | undefined): void {
  if (!isJsonObject(value) || Object.keys(value).length === 0) {
    throw new FeishuGatewayError(
      'invalid_pending_action',
      'ask-user-question submit requires a non-empty answer object',
    );
  }
  for (const [key, answer] of Object.entries(value)) {
    if (
      key.length === 0 ||
      new TextEncoder().encode(key).byteLength > 128 ||
      CONTROL.test(key) ||
      !boundedAnswer(answer)
    ) {
      throw new FeishuGatewayError(
        'invalid_pending_action',
        'ask-user-question answer does not match the bounded answer schema',
      );
    }
  }
  const display = parseRemoteHostAskQuestionDisplay(request.display);
  if (!display) {
    throw new FeishuGatewayError(
      'invalid_core_response',
      'ask-user-question display is malformed',
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...display.questionIds].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    throw new FeishuGatewayError(
      'invalid_pending_action',
      'ask-user-question answers must match every displayed question id',
    );
  }
}

export function validatePendingActionSemantics(
  request: PendingRequestDto,
  action: FeishuPendingAction['action'],
  value: JsonValue | undefined,
): void {
  if (request.kind === 'permission') {
    if (!['approve', 'deny'].includes(action) || value !== undefined) {
      throw new FeishuGatewayError(
        'invalid_pending_action',
        'permission accepts only approve|deny without a value',
      );
    }
    return;
  }
  if (request.kind === 'ask-user-question') {
    if (action !== 'submit') {
      throw new FeishuGatewayError(
        'invalid_pending_action',
        'ask-user-question accepts only submit',
      );
    }
    validateQuestionValue(request, value);
    return;
  }
  if (!['accept', 'reject'].includes(action) || value !== undefined) {
    throw new FeishuGatewayError(
      'invalid_pending_action',
      `${request.kind} accepts only accept|reject without a value`,
    );
  }
}
