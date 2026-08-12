import { describe, expect, it } from 'vitest';

import {
  parseRemoteHostPlanReviewAsk,
  parseRemoteHostPlanReviewTarget,
} from './input-validation-plan-review';

const target = {
  profileId: 'profile-a',
  sessionId: 'session-a',
  requestId: 'request-a',
  expectedAuthority: { authoritativeCoreId: 'core-a', workerGeneration: 3 },
  intentId: 'intent-a',
  expectedRevision: 4,
};

describe('Remote plan review input validation', () => {
  it('accepts exact targets and bounded multiline questions', () => {
    expect(parseRemoteHostPlanReviewTarget(target)).toEqual(target);
    expect(parseRemoteHostPlanReviewAsk({ ...target, question: '检查竞态\n以及回滚。' }))
      .toEqual({ ...target, question: '检查竞态\n以及回滚。' });
  });

  it('rejects extra fields, stale revision shapes, and invalid questions', () => {
    expect(() => parseRemoteHostPlanReviewTarget({ ...target, role: 'local' })).toThrow();
    expect(() => parseRemoteHostPlanReviewTarget({ ...target, expectedRevision: -1 })).toThrow();
    expect(() => parseRemoteHostPlanReviewAsk({ ...target, question: '   ' })).toThrow();
    expect(() => parseRemoteHostPlanReviewAsk({ ...target, question: 'bad\u0000value' })).toThrow();
  });
});
