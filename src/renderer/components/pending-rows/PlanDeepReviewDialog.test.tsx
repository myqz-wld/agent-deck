// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    generatePlanDeepReviewFeedback: vi.fn(async () => ({ feedback: 'Revise lifecycle checks.' })),
    ...overrides,
  } as unknown as Window['api'];
}

function renderDialog(props: Partial<Parameters<typeof PlanDeepReviewDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onApprove = vi.fn(async () => true);
  const onRevise = vi.fn(async () => true);
  const view = render(
    <PlanDeepReviewDialog
      open
      sourceSessionId="source"
      request={request}
      decisionBusy={false}
      onClose={onClose}
      onApprove={onApprove}
      onRevise={onRevise}
      {...props}
    />,
  );
  return { onClose, onApprove, onRevise, unmount: view.unmount };
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
    const approve = screen.getByRole('button', { name: '批准计划' });
    approve.focus();
    fireEvent.keyDown(approve, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(approve);

    fireEvent.keyDown(close, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.inert).toBe(false);
    expect(trigger.hasAttribute('aria-hidden')).toBe(false);
    trigger.remove();
  });

  it('opens a quote action from the selected plan text context menu and sends it', async () => {
    renderDialog();
    await waitFor(() => expect(window.api.startPlanDeepReview).toHaveBeenCalledTimes(1));

    const selected = screen.getByText('Selected risk must be validated.');
    const range = document.createRange();
    range.selectNodeContents(selected);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const plan = screen.getByTestId('plan-review-plan');
    fireEvent.contextMenu(plan, { clientX: 120, clientY: 80 });
    selection?.removeAllRanges();
    fireEvent.click(screen.getByRole('menuitem', { name: /引用到提问/ }));

    const question = screen.getByTestId('plan-review-question') as HTMLTextAreaElement;
    expect(question.value).toBe('');
    expect(screen.getByTestId('plan-review-quote').textContent)
      .toContain('Selected risk must be validated.');
    fireEvent.change(question, { target: { value: 'What should change?' } });
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }));

    await waitFor(() => expect(window.api.askPlanDeepReview).toHaveBeenCalledWith(
      'source',
      'plan-1',
      '> Selected risk must be validated.\n\nWhat should change?',
    ));
  });

  it('keeps manual feedback in the bottom decision tray and submits it explicitly', async () => {
    const { onRevise, onClose } = renderDialog();
    const feedback = screen.getByRole('textbox', { name: '修改意见（可选）' });
    fireEvent.change(feedback, { target: { value: 'Add a rollback step.' } });
    fireEvent.click(screen.getByRole('button', { name: '继续修改' }));

    await waitFor(() => expect(onRevise).toHaveBeenCalledWith('Add a rollback step.'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('quotes selected plan text with the platform shortcut without a selection mode', async () => {
    renderDialog();
    await waitFor(() => expect(
      (screen.getByTestId('plan-review-question') as HTMLTextAreaElement).disabled,
    ).toBe(false));
    const selected = screen.getByText('Selected risk must be validated.');
    const range = document.createRange();
    range.selectNodeContents(selected);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const plan = screen.getByTestId('plan-review-plan');
    expect(plan.getAttribute('aria-keyshortcuts')).toBe('Meta+Enter');
    plan.focus();
    fireEvent.keyDown(plan, { key: 'Enter', ctrlKey: true });
    expect(screen.queryByTestId('plan-review-quote')).toBeNull();
    fireEvent.keyDown(plan, { key: 'Enter', metaKey: true });

    expect((screen.getByTestId('plan-review-question') as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByTestId('plan-review-quote').textContent)
      .toContain('Selected risk must be validated.');
    expect(screen.queryByRole('button', { name: '引用所选' })).toBeNull();
    expect(screen.queryByRole('button', { name: '键盘选择' })).toBeNull();
    await waitFor(() => expect(document.activeElement)
      .toBe(screen.getByTestId('plan-review-question')));
  });

  it('keeps multiple rendered quotes outside the question and removes them independently', async () => {
    renderDialog();
    await waitFor(() => expect(
      (screen.getByTestId('plan-review-question') as HTMLTextAreaElement).disabled,
    ).toBe(false));
    const selected = screen.getByText('Selected risk must be validated.');
    const range = document.createRange();
    range.selectNodeContents(selected);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const plan = screen.getByTestId('plan-review-plan');
    fireEvent.contextMenu(plan, { clientX: 120, clientY: 80 });
    fireEvent.click(screen.getByRole('menuitem', { name: /引用到提问/ }));
    const second = screen.getByText('Implement the gate.');
    const secondRange = document.createRange();
    secondRange.selectNodeContents(second);
    selection?.removeAllRanges();
    selection?.addRange(secondRange);
    fireEvent.contextMenu(plan, { clientX: 120, clientY: 80 });
    fireEvent.click(screen.getByRole('menuitem', { name: /引用到提问/ }));
    const question = screen.getByTestId('plan-review-question');
    fireEvent.change(question, { target: { value: 'Keep this draft.' } });

    expect(screen.getAllByTestId('plan-review-quote')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '移除第 1 条计划引用' }));

    expect(screen.getAllByTestId('plan-review-quote')).toHaveLength(1);
    expect(screen.getByTestId('plan-review-quote').textContent).toContain('Implement the gate.');
    expect((question as HTMLTextAreaElement).value).toBe('Keep this draft.');
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
    await waitFor(() => expect(window.api.askPlanDeepReview).toHaveBeenCalledWith(
      'source',
      'plan-1',
      '> Implement the gate.\n\nKeep this draft.',
    ));
  });

  it('does not open the quote menu when no plan text is selected', async () => {
    renderDialog();
    await waitFor(() => expect(window.api.startPlanDeepReview).toHaveBeenCalledTimes(1));

    fireEvent.contextMenu(screen.getByTestId('plan-review-plan'), { clientX: 120, clientY: 80 });

    expect(screen.queryByRole('menu', { name: '计划文本引用' })).toBeNull();
  });

  it('keeps the deep-review title clear of the frameless window controls', () => {
    renderDialog();

    const header = screen.getByText('计划深度审阅').closest('header');
    expect(header?.className).toContain('pl-[78px]');
    expect(within(header!).queryByRole('button', { name: '批准计划' })).toBeNull();
    const footer = screen.getByTestId('plan-review-decision-footer');
    expect(within(footer).getByRole('button', { name: '继续修改' })).toBeTruthy();
    expect(within(footer).getByRole('button', { name: '批准计划' })).toBeTruthy();
    expect(within(footer).getByRole('button', { name: '根据上下文生成意见' })).toBeTruthy();
  });

  it('generates an editable feedback draft and waits for explicit confirmation', async () => {
    const { onRevise, onClose } = renderDialog();
    await waitFor(() => expect(
      screen.getByRole('button', { name: '根据上下文生成意见' }).hasAttribute('disabled'),
    ).toBe(false));
    const feedback = screen.getByTestId('plan-review-feedback') as HTMLTextAreaElement;
    fireEvent.change(feedback, { target: { value: 'Keep this manual note.' } });
    fireEvent.click(screen.getByRole('button', { name: '根据上下文生成意见' }));

    await waitFor(() => expect(window.api.generatePlanDeepReviewFeedback).toHaveBeenCalledWith(
      'source',
      'plan-1',
    ));
    await waitFor(() => expect(feedback.value)
      .toBe('Keep this manual note.\n\nRevise lifecycle checks.'));
    await waitFor(() => expect(document.activeElement).toBe(feedback));
    expect(onRevise).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.change(feedback, { target: { value: 'Reviewed lifecycle checks.' } });
    fireEvent.click(screen.getByRole('button', { name: '继续修改' }));
    await waitFor(() => expect(onRevise).toHaveBeenCalledWith('Reviewed lifecycle checks.'));
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

  it('blocks question submission while a feedback draft is being generated', async () => {
    const automatic = deferred<{ feedback: string }>();
    window.api = api({
      generatePlanDeepReviewFeedback: vi.fn(() => automatic.promise),
    });
    const { onClose, onRevise } = renderDialog();
    await waitFor(() => expect(
      screen.getByRole('button', { name: '根据上下文生成意见' }).hasAttribute('disabled'),
    ).toBe(false));
    const question = screen.getByTestId('plan-review-question') as HTMLTextAreaElement;
    fireEvent.change(question, { target: { value: 'Can this overlap?' } });

    fireEvent.click(screen.getByRole('button', { name: '根据上下文生成意见' }));
    expect(question.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
    expect(window.api.askPlanDeepReview).not.toHaveBeenCalled();

    automatic.resolve({ feedback: 'No overlap.' });
    await waitFor(() => expect(
      (screen.getByTestId('plan-review-feedback') as HTMLTextAreaElement).value,
    ).toBe('No overlap.'));
    expect(onClose).not.toHaveBeenCalled();
    expect(onRevise).not.toHaveBeenCalled();
  });

  it('preserves a manual feedback draft when LLM generation fails', async () => {
    window.api = api({
      generatePlanDeepReviewFeedback: vi.fn(async () => {
        throw new Error('generation failed');
      }),
    });
    renderDialog();
    await waitFor(() => expect(
      screen.getByRole('button', { name: '根据上下文生成意见' }).hasAttribute('disabled'),
    ).toBe(false));
    const feedback = screen.getByTestId('plan-review-feedback') as HTMLTextAreaElement;
    fireEvent.change(feedback, { target: { value: 'Keep my manual draft.' } });

    fireEvent.click(screen.getByRole('button', { name: '根据上下文生成意见' }));

    expect((await screen.findByRole('alert')).textContent).toContain('意见草稿生成失败');
    expect(feedback.value).toBe('Keep my manual draft.');
  });

  it('closes the quote menu with Escape without closing the dialog', async () => {
    const { onClose } = renderDialog();
    await waitFor(() => expect(window.api.startPlanDeepReview).toHaveBeenCalledTimes(1));
    const selected = screen.getByText('Selected risk must be validated.');
    const range = document.createRange();
    range.selectNodeContents(selected);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const plan = screen.getByTestId('plan-review-plan');
    fireEvent.contextMenu(plan, { clientX: 120, clientY: 80 });
    const menuitem = screen.getByRole('menuitem', { name: /引用到提问/ });

    fireEvent.keyDown(menuitem, { key: 'Escape' });

    expect(screen.queryByRole('menu', { name: '计划文本引用' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(plan));
  });

  it.each([
    { shiftKey: false, target: 'question' },
    { shiftKey: true, target: 'close' },
  ])('closes the quote menu and moves $target on Tab', async ({ shiftKey, target }) => {
    const { onClose } = renderDialog();
    await waitFor(() => expect(
      (screen.getByTestId('plan-review-question') as HTMLTextAreaElement).disabled,
    ).toBe(false));
    const selected = screen.getByText('Selected risk must be validated.');
    const range = document.createRange();
    range.selectNodeContents(selected);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const plan = screen.getByTestId('plan-review-plan');
    fireEvent.contextMenu(plan, { clientX: 120, clientY: 80 });

    fireEvent.keyDown(screen.getByRole('menuitem', { name: /引用到提问/ }), {
      key: 'Tab',
      shiftKey,
    });

    expect(screen.queryByRole('menu', { name: '计划文本引用' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    const expected = target === 'question'
      ? screen.getByTestId('plan-review-question')
      : screen.getByRole('button', { name: '关闭深度审阅' });
    await waitFor(() => expect(document.activeElement).toBe(expected));
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
