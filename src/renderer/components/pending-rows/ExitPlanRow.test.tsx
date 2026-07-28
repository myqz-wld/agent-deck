// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
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
  it('opens the complete typed plan without duplicating decision actions', () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {} as Window['api'],
    });
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

    const trigger = screen.getByRole('button', { name: '展开完整计划' });
    expect(trigger.className).toContain('h-11');
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: '完整计划 · Lifecycle plan' });
    expect(dialog.textContent).toContain('Validate handoff cleanup.');
    expect(within(dialog).queryByRole('button', { name: '确认计划' })).toBeNull();
  });

  it('keeps feedback multiline, expands it, and submits with the explicit shortcut', async () => {
    const respondExitPlanMode = vi.fn(async () => ({ resolvedSessionId: 'source' }));
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { respondExitPlanMode } as unknown as Window['api'],
    });
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
    fireEvent.click(screen.getByRole('button', { name: '继续规划' }));
    const feedback = screen.getByLabelText('计划修改意见') as HTMLTextAreaElement;
    fireEvent.change(feedback, { target: { value: 'First line\nSecond line' } });
    fireEvent.click(screen.getByRole('button', { name: '展开计划修改意见' }));
    const expandedFeedback = screen.getByLabelText(
      '计划修改意见（展开）',
    ) as HTMLTextAreaElement;
    expect(expandedFeedback.value)
      .toBe('First line\nSecond line');

    fireEvent.keyDown(expandedFeedback, { key: 'Enter' });
    expect(respondExitPlanMode).not.toHaveBeenCalled();
    fireEvent.keyDown(expandedFeedback, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(respondExitPlanMode).toHaveBeenCalledWith(
      'codex-cli',
      'source',
      'plan-1',
      { decision: 'keep-planning', feedback: 'First line\nSecond line' },
    ));
  });

  it('keeps a failed decision on the row with actionable copy', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        respondExitPlanMode: vi.fn(async () => {
          throw new Error('provider internals');
        }),
      } as unknown as Window['api'],
    });
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
    fireEvent.click(screen.getByRole('button', { name: '确认计划' }));

    expect((await screen.findByRole('alert')).textContent)
      .toBe('计划响应失败，请确认计划仍在等待后重试。');
    expect(screen.queryByText('provider internals')).toBeNull();
  });

  it('uses canonical punctuation for native permission-mode copy', () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {} as Window['api'],
    });
    const nativePayload: ExitPlanModeRequest = {
      ...payload,
      reviewSource: 'adapter',
    };
    render(
      <ExitPlanRow
        event={{ ...event, payload: nativePayload }}
        payload={nativePayload}
        sessionId="source"
        agentId="codex-cli"
        isSdk
        stillPending
        wasCancelled={false}
        onResolved={vi.fn()}
      />,
    );

    const modeSelect = screen.getByTitle(
      '批准计划后切换到的权限模式（完全免询问需要重启会话）',
    );
    fireEvent.click(modeSelect);
    fireEvent.click(screen.getByRole('option', { name: '⚠️ 不再询问' }));

    expect(screen.getByTitle(
      '批准计划并切到完全免询问模式（需重启会话，5–10 秒）',
    )).toBeTruthy();
  });

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
