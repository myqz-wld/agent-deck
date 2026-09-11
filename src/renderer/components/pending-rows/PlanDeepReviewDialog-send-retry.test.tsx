// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { usePlanDeepReviewStore } from '@renderer/stores/plan-deep-review-store';
import { useSessionStore } from '@renderer/stores/session-store';
import { api, renderDialog } from './PlanDeepReviewDialog-test-fixture';

beforeEach(() => {
  usePlanDeepReviewStore.setState({ drafts: new Map() });
  useSessionStore.setState({
    recentEventsBySession: new Map(), eventRevisionsBySession: new Map(),
  });
  Object.defineProperty(window, 'api', {
    configurable: true, writable: true, value: api(),
  });
});

afterEach(() => cleanup());

describe('PlanDeepReviewDialog question retry', () => {
  it.each([
    ['start', '审阅会话创建失败，问题尚未发送，请稍后重试。', 2],
    ['ask', '问题发送失败，请稍后重试。', 1],
  ] as const)('restores the question and quote after %s fails, then retries', async (
    stage, errorCopy, expectedStarts,
  ) => {
    const start = vi.mocked(window.api.startPlanDeepReview);
    const ask = vi.mocked(window.api.askPlanDeepReview);
    const failure = new Error('internal provider failure');
    if (stage === 'start') start.mockRejectedValueOnce(failure);
    else ask.mockRejectedValueOnce(failure);
    usePlanDeepReviewStore.getState().patchDraft('plan-1', {
      question: 'Allow switching modes when recreating the account.',
      planQuotes: [{ id: 1, text: 'Mode is fixed after creation.' }],
    });
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }));

    expect(await screen.findByText(errorCopy)).toBeTruthy();
    const question = screen.getByTestId('plan-review-question') as HTMLTextAreaElement;
    expect(question.value).toBe('Allow switching modes when recreating the account.');
    expect(screen.getByTestId('plan-review-quote').textContent)
      .toContain('Mode is fixed after creation.');
    expect(question.disabled).toBe(false);
    if (stage === 'start') expect(ask).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '发送问题' }));

    await waitFor(() => expect(ask).toHaveBeenLastCalledWith(
      'source', 'plan-1',
      '> Mode is fixed after creation.\n\nAllow switching modes when recreating the account.',
    ));
    await waitFor(() => expect(question.disabled).toBe(false));
    expect(start).toHaveBeenCalledTimes(expectedStarts);
    expect(question.value).toBe('');
    expect(screen.queryByTestId('plan-review-quote')).toBeNull();
    expect(screen.queryByText(errorCopy)).toBeNull();
    expect(screen.queryByText('无法创建隔离的审阅会话。请稍后重试。')).toBeNull();
  });
});
