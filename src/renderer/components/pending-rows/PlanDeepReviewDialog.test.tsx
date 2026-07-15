// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ExitPlanModeRequest } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { PlanDeepReviewDialog } from './PlanDeepReviewDialog';

const request: ExitPlanModeRequest = {
  type: 'exit-plan-mode',
  requestId: 'plan-1',
  reviewSource: 'mcp',
  title: 'Lifecycle plan',
  plan: '## Plan\n\nSelected risk must be validated.\n\n1. Implement the gate.',
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function api(overrides: Record<string, unknown> = {}): Window['api'] {
  return {
    startPlanDeepReview: vi.fn(async () => ({
      sessionId: 'review-child',
      agentId: 'codex-cli',
    })),
    listEvents: vi.fn(async () => []),
    askPlanDeepReview: vi.fn(async () => true),
    autoFeedbackPlanDeepReview: vi.fn(async () => ({ feedback: 'Revise lifecycle checks.' })),
    ...overrides,
  } as unknown as Window['api'];
}

function renderDialog(props: Partial<Parameters<typeof PlanDeepReviewDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onApprove = vi.fn(async () => true);
  const onRevise = vi.fn(async () => true);
  const onAutoSubmitted = vi.fn();
  const view = render(
    <PlanDeepReviewDialog
      open
      sourceSessionId="source"
      request={request}
      decisionBusy={false}
      onClose={onClose}
      onApprove={onApprove}
      onRevise={onRevise}
      onAutoSubmitted={onAutoSubmitted}
      {...props}
    />,
  );
  return { onClose, onApprove, onRevise, onAutoSubmitted, unmount: view.unmount };
}

beforeEach(() => {
  useSessionStore.setState({
    recentEventsBySession: new Map(),
    eventRevisionsBySession: new Map(),
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: api(),
  });
});

afterEach(() => cleanup());

describe('PlanDeepReviewDialog', () => {
  it('focuses and traps the modal, hides the background, handles Escape, and restores focus', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Open review';
    document.body.append(trigger);
    trigger.focus();
    const { onClose, unmount } = renderDialog();

    const close = screen.getByRole('button', { name: '关闭深度审阅' });
    expect(document.activeElement).toBe(close);
    expect(trigger.inert).toBe(true);
    expect(trigger.getAttribute('aria-hidden')).toBe('true');

    await waitFor(() => expect(
      (screen.getByTestId('plan-review-question') as HTMLTextAreaElement).disabled,
    ).toBe(false));
    const question = screen.getByTestId('plan-review-question');
    question.focus();
    fireEvent.keyDown(question, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '批准计划' }));

    fireEvent.keyDown(close, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.inert).toBe(false);
    expect(trigger.hasAttribute('aria-hidden')).toBe(false);
    trigger.remove();
  });

  it('quotes selected plan text into the dedicated question composer and sends it', async () => {
    renderDialog();
    await waitFor(() => expect(window.api.startPlanDeepReview).toHaveBeenCalledTimes(1));

    const selected = screen.getByText('Selected risk must be validated.');
    const range = document.createRange();
    range.selectNodeContents(selected);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.mouseUp(screen.getByTestId('plan-review-plan'));
    fireEvent.click(screen.getByRole('button', { name: '引用所选' }));

    const question = screen.getByTestId('plan-review-question') as HTMLTextAreaElement;
    expect(question.value).toContain('> Selected risk must be validated.');
    fireEvent.change(question, { target: { value: `${question.value}What should change?` } });
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }));

    await waitFor(() => expect(window.api.askPlanDeepReview).toHaveBeenCalledWith(
      'source',
      'plan-1',
      expect.stringContaining('What should change?'),
    ));
  });

  it('keeps continue-modifying as a two-step feedback action', async () => {
    const { onRevise, onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '继续修改' }));
    const feedback = screen.getByPlaceholderText('反馈可选；再次点击“继续修改”提交');
    fireEvent.change(feedback, { target: { value: 'Add a rollback step.' } });
    fireEvent.click(screen.getByRole('button', { name: '继续修改' }));

    await waitFor(() => expect(onRevise).toHaveBeenCalledWith('Add a rollback step.'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('supports partial plan selection and quoting entirely by keyboard', async () => {
    renderDialog();
    await waitFor(() => expect(
      (screen.getByTestId('plan-review-question') as HTMLTextAreaElement).disabled,
    ).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '键盘选择' }));
    const source = screen.getByRole('textbox', { name: '用键盘选择计划文本' }) as HTMLTextAreaElement;
    const start = source.value.indexOf('Selected risk');
    const end = start + 'Selected risk must be validated.'.length;
    source.focus();
    source.setSelectionRange(start, end);
    fireEvent.select(source);
    fireEvent.click(screen.getByRole('button', { name: '引用所选' }));

    expect((screen.getByTestId('plan-review-question') as HTMLTextAreaElement).value)
      .toContain('> Selected risk must be validated.');
    await waitFor(() => expect(document.activeElement)
      .toBe(screen.getByTestId('plan-review-question')));
  });

  it('submits context-derived feedback to the original plan gate', async () => {
    const { onAutoSubmitted, onClose } = renderDialog();
    await waitFor(() => expect(
      screen.getByRole('button', { name: '根据上下文提意见' }).hasAttribute('disabled'),
    ).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '根据上下文提意见' }));

    await waitFor(() => expect(window.api.autoFeedbackPlanDeepReview).toHaveBeenCalledWith(
      'source',
      'plan-1',
    ));
    expect(onAutoSubmitted).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('blocks question submission while plan approval is in flight', async () => {
    const approval = deferred<boolean>();
    const onApprove = vi.fn(() => approval.promise);
    renderDialog({ onApprove });
    await waitFor(() => expect(
      (screen.getByTestId('plan-review-question') as HTMLTextAreaElement).disabled,
    ).toBe(false));
    const question = screen.getByTestId('plan-review-question') as HTMLTextAreaElement;
    fireEvent.change(question, { target: { value: 'Can this race?' } });

    fireEvent.click(screen.getByRole('button', { name: '批准计划' }));
    expect(question.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
    expect(window.api.askPlanDeepReview).not.toHaveBeenCalled();

    approval.resolve(false);
    await waitFor(() => expect(question.disabled).toBe(false));
  });

  it('blocks question submission while automatic feedback is in flight', async () => {
    const automatic = deferred<{ feedback: string }>();
    window.api = api({
      autoFeedbackPlanDeepReview: vi.fn(() => automatic.promise),
    });
    const { onAutoSubmitted } = renderDialog();
    await waitFor(() => expect(
      screen.getByRole('button', { name: '根据上下文提意见' }).hasAttribute('disabled'),
    ).toBe(false));
    const question = screen.getByTestId('plan-review-question') as HTMLTextAreaElement;
    fireEvent.change(question, { target: { value: 'Can this overlap?' } });

    fireEvent.click(screen.getByRole('button', { name: '根据上下文提意见' }));
    expect(question.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
    expect(window.api.askPlanDeepReview).not.toHaveBeenCalled();

    automatic.resolve({ feedback: 'No overlap.' });
    await waitFor(() => expect(onAutoSubmitted).toHaveBeenCalledOnce());
  });

  it('shows stable Chinese copy while keeping provider fork details out of the UI', async () => {
    window.api = api({
      startPlanDeepReview: vi.fn(async () => {
        throw new Error('native fork unavailable; retry with contextMode "fresh"');
      }),
    });
    renderDialog();

    expect(await screen.findByText(
      '无法创建隔离的原生 fork。请等待当前会话到达安全边界后重试。',
    )).toBeTruthy();
    expect(screen.queryByText(/contextMode "fresh"/)).toBeNull();
  });
});
