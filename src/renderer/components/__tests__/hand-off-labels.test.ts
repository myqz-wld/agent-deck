import { describe, expect, it } from 'vitest';
import type { SessionHandOffExecutionFailure } from '@shared/types';
import { executionFailureLabel } from '../hand-off/labels';

function failure(
  input: Partial<SessionHandOffExecutionFailure> = {},
): SessionHandOffExecutionFailure {
  return {
    stage: 'cutover',
    successorSessionId: 'successor',
    successorCleanup: 'ok',
    usedLowerBudgetRetry: false,
    message: 'private internal detail',
    ...input,
  };
}

describe('handoff execution failure labels', () => {
  it.each([
    'target-acceptance-timeout',
    'target-provider-rejected',
    'target-retry-rejected',
    'late-message-delivery-failed',
    'message-delivery-drain-timeout',
  ] as const)('warns that retry may duplicate effects after %s', (cutoverReason) => {
    const label = executionFailureLabel(failure({ cutoverReason }));

    expect(label).toContain('可能已经执行');
    expect(label).toContain('重试可能造成重复执行');
    expect(label).toContain('请先检查实际结果');
  });

  it('warns for a post-create transfer failure without a cutover reason', () => {
    const label = executionFailureLabel(failure({ stage: 'transfer' }));

    expect(label).toContain('可能已经执行');
    expect(label).toContain('重试可能造成重复执行');
  });

  it.each([
    'target-startup-timeout',
    'target-retry-startup-failed',
    'target-context-rejected',
    'target-rollback-failed',
  ] as const)('does not claim partial execution after %s', (cutoverReason) => {
    const label = executionFailureLabel(failure({ cutoverReason }));

    expect(label).not.toContain('可能已经执行');
    expect(label).not.toContain('重试可能造成重复执行');
  });
});
