import { isJsonObject } from './json';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u;

export type SessionHistoryMutationState = 'archived' | 'deleted' | 'reactivated' | 'unarchived';

export interface SessionHistoryMutationParams {
  sessionId: string;
  expectedArchived: boolean;
  expectedUpdatedAt: number;
}

export interface SessionHistoryMutationResult {
  sessionId: string;
  state: SessionHistoryMutationState;
  revision: number;
}

function fail(field: string): never {
  throw new Error(`${field} is invalid`);
}

function exact(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(field);
  }
}

function token(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value.length > 256 || !TOKEN.test(value)) fail(field);
  return value;
}

function revision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(field);
  return value as number;
}

export function parseSessionHistoryMutationParams(
  value: unknown,
): SessionHistoryMutationParams {
  if (!isJsonObject(value)) fail('session.history.mutation.params');
  exact(
    value,
    ['expectedArchived', 'expectedUpdatedAt', 'sessionId'],
    'session.history.mutation.params',
  );
  if (typeof value.expectedArchived !== 'boolean') {
    fail('session.history.mutation.expectedArchived');
  }
  return {
    sessionId: token(value.sessionId, 'session.history.mutation.sessionId'),
    expectedArchived: value.expectedArchived,
    expectedUpdatedAt: revision(
      value.expectedUpdatedAt,
      'session.history.mutation.expectedUpdatedAt',
    ),
  };
}

export function parseSessionHistoryMutationResult(
  value: unknown,
  expectedSessionId?: string,
  expectedState?: SessionHistoryMutationState,
): SessionHistoryMutationResult {
  if (!isJsonObject(value)) fail('session.history.mutation.result');
  exact(value, ['revision', 'sessionId', 'state'], 'session.history.mutation.result');
  const sessionId = token(value.sessionId, 'session.history.mutation.sessionId');
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) {
    fail('session.history.mutation.sessionId');
  }
  if (!['archived', 'deleted', 'reactivated', 'unarchived'].includes(String(value.state))) {
    fail('session.history.mutation.state');
  }
  const state = value.state as SessionHistoryMutationState;
  if (expectedState !== undefined && state !== expectedState) fail('session.history.mutation.state');
  return {
    sessionId,
    state,
    revision: revision(value.revision, 'session.history.mutation.revision'),
  };
}
