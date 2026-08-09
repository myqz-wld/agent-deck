import type { RemoteHostJsonObject } from './types';

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;
const UTF8 = new TextEncoder();

export const REMOTE_HOST_FALLBACK_QUESTION_ID = 'answer';

export function boundedRemoteHostQuestionIds(
  display: RemoteHostJsonObject,
): string[] | null {
  const value = display.questionIds;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 32 ||
    !value.every((item) =>
      typeof item === 'string' &&
      item.length > 0 &&
      UTF8.encode(item).byteLength <= 128 &&
      !CONTROL.test(item)) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return [...value] as string[];
}

export function remoteHostQuestionIds(display: RemoteHostJsonObject): string[] {
  return boundedRemoteHostQuestionIds(display) ?? [REMOTE_HOST_FALLBACK_QUESTION_ID];
}

export function hasMalformedRemoteHostQuestionIds(display: RemoteHostJsonObject): boolean {
  return display.questionIds !== undefined && boundedRemoteHostQuestionIds(display) === null;
}
