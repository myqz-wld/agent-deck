// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentEvent, ExitPlanModeRequest } from '@shared/types';
import { usePlanDeepReviewStore } from '@renderer/stores/plan-deep-review-store';
import { useSessionStore } from '@renderer/stores/session-store';
import { ExitPlanRow } from './ExitPlanRow';

const payload: ExitPlanModeRequest = {
  type: 'exit-plan-mode',
  requestId: 'plan-1',
  reviewSource: 'mcp',
  title: 'Lifecycle plan',
  plan: '## Plan\n\nValidate handoff cleanup.',
};

const event: AgentEvent = {
  sessionId: 'source',
  agentId: 'codex-cli',
  kind: 'waiting-for-user',
  payload,
  ts: 1,
  source: 'sdk',
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  usePlanDeepReviewStore.setState({ drafts: new Map() });
});

describe('ExitPlanRow', () => {
  it('clears the authoritative successor bucket returned after a handoff race', async () => {
    const respondExitPlanMode = vi.fn(async () => ({ resolvedSessionId: 'successor' }));
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { respondExitPlanMode } as unknown as Window['api'],
    });
    const onResolved = vi.fn();
    render(
      <ExitPlanRow
        event={event}
        payload={payload}
        sessionId="source"
        agentId="codex-cli"
        isSdk
        stillPending
        wasCancelled={false}
        onResolved={onResolved}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '确认计划' }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith('successor', 'plan-1'));
    expect(respondExitPlanMode).toHaveBeenCalledWith(
      'codex-cli',
      'source',
      'plan-1',
      { decision: 'approve', targetMode: 'default' },
    );
  });

  it('keeps an in-flight deep review alive while closed and restores it when reopened', async () => {
    const reply = deferred<boolean>();
    const askPlanDeepReview = vi.fn(() => reply.promise);
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        startPlanDeepReview: vi.fn(async () => ({
          sessionId: 'review-child',
          agentId: 'codex-cli',
        })),
        listEvents: vi.fn(async () => []),
        askPlanDeepReview,
        generatePlanDeepReviewFeedback: vi.fn(async () => ({ feedback: '' })),
      } as unknown as Window['api'],
    });
    useSessionStore.setState({
      recentEventsBySession: new Map(),
      eventRevisionsBySession: new Map(),
    });
    const firstView = render(
      <ExitPlanRow
        event={event}
        payload={payload}
        sessionId="source"
        agentId="codex-cli"
        isSdk
        stillPending
        wasCancelled={false}
        onResolved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '深度审阅' }));
    const question = screen.getByTestId('plan-review-question');
    fireEvent.change(question, { target: { value: 'Review this while I do other work.' } });
    fireEvent.change(screen.getByTestId('plan-review-feedback'), {
      target: { value: 'Keep this draft while the review runs.' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
    await waitFor(() => expect(askPlanDeepReview).toHaveBeenCalledOnce());

    const close = screen.getByRole('button', { name: '关闭深度审阅' });
    expect(close.hasAttribute('disabled')).toBe(false);
    expect(close.getAttribute('title')).toBe('关闭窗口；正在进行的审阅会继续');
    fireEvent.click(close);
    expect(screen.queryByRole('dialog', { name: '计划深度审阅' })).toBeNull();
    expect(screen.getByRole('button', { name: '审阅进行中…' }).getAttribute('title'))
      .toBe('审阅正在后台继续；点击返回查看进度');

    firstView.unmount();
    render(
      <ExitPlanRow
        event={event}
        payload={payload}
        sessionId="source"
        agentId="codex-cli"
        isSdk
        stillPending
        wasCancelled={false}
        onResolved={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '审阅进行中…' }));
    expect(screen.getByTestId('plan-review-reply-loading')).toBeTruthy();
    expect((screen.getByTestId('plan-review-feedback') as HTMLTextAreaElement).value)
      .toBe('Keep this draft while the review runs.');
    expect(askPlanDeepReview).toHaveBeenCalledTimes(1);

    reply.resolve(true);
    await waitFor(() => expect(screen.queryByTestId('plan-review-reply-loading')).toBeNull());
  });
});
