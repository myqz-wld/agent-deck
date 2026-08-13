import { describe, expect, it } from 'vitest';

import {
  parseSessionHistoryMutationParams,
  parseSessionHistoryMutationResult,
} from './session-history-mutations';

describe('session history mutation contract', () => {
  it('binds a mutation to the displayed history row', () => {
    expect(parseSessionHistoryMutationParams({
      sessionId: 'session-a', expectedArchived: false, expectedUpdatedAt: 42,
    })).toEqual({ sessionId: 'session-a', expectedArchived: false, expectedUpdatedAt: 42 });
    expect(parseSessionHistoryMutationResult({
      sessionId: 'session-a', state: 'archived', revision: 43,
    }, 'session-a', 'archived')).toEqual({
      sessionId: 'session-a', state: 'archived', revision: 43,
    });
    expect(parseSessionHistoryMutationResult({
      sessionId: 'session-a', state: 'reactivated', revision: 44,
    }, 'session-a', 'reactivated').state).toBe('reactivated');
  });

  it('rejects malformed, extra-field, and wrong-identity results', () => {
    expect(() => parseSessionHistoryMutationParams({
      sessionId: '../escape', expectedArchived: false, expectedUpdatedAt: 1,
    })).toThrow();
    expect(() => parseSessionHistoryMutationParams({
      sessionId: 'session-a', expectedArchived: false, expectedUpdatedAt: 1, extra: true,
    })).toThrow();
    expect(() => parseSessionHistoryMutationResult({
      sessionId: 'session-b', state: 'deleted', revision: 2,
    }, 'session-a', 'deleted')).toThrow();
  });
});
