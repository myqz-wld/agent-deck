// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HandOffPreviewDialog } from '../HandOffPreviewDialog';
import { localHandOffDrafts } from '../hand-off/local-draft';
import { otherSource, prepared, source } from './HandOffPreviewDialog.fixture';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const handOffPrepare = vi.fn();
const handOffCommit = vi.fn();
const handOffCancel = vi.fn();
beforeEach(() => {
  localHandOffDrafts.clear();
  handOffPrepare.mockReset().mockResolvedValue(prepared);
  handOffCommit.mockReset().mockResolvedValue({ status: 'success' });
  handOffCancel.mockReset().mockResolvedValue(true);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      listAdapters: vi.fn().mockResolvedValue([
        { id: 'claude-code', displayName: 'Claude', capabilities: { canCreateSession: true } },
        { id: 'codex-cli', displayName: 'Codex', capabilities: { canCreateSession: true } },
      ]),
      listClaudeGatewayProfiles: vi.fn().mockResolvedValue([]),
      listCodexGatewayProfiles: vi.fn().mockResolvedValue([]),
      handOffPrepare, handOffCommit, handOffCancel,
    },
  });
});
afterEach(() => {
  cleanup();
  localHandOffDrafts.clear();
  Reflect.deleteProperty(window, 'api');
});

const instructionLabel = '下一步指令 / 补充与修正';
const commitLabel = '打开新会话接力';

describe('Local handoff view lifetime', () => {
  it('keeps a pending preparation and its choices across close and a real remount', async () => {
    const pending = deferred<typeof prepared>();
    handOffPrepare.mockReturnValueOnce(pending.promise);
    const onClose = vi.fn();
    const view = render(<HandOffPreviewDialog open session={source} onClose={onClose} />);
    fireEvent.click(await screen.findByLabelText('目标助手'));
    fireEvent.click(screen.getByRole('option', { name: 'Codex' }));
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'custom-model' } });
    fireEvent.change(screen.getByLabelText(instructionLabel), { target: { value: '保留这份指令' } });
    fireEvent.click(screen.getByRole('button', { name: '生成续接上下文' }));
    await waitFor(() => expect(handOffPrepare).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '关闭接力窗口' }));
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();

    render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    expect(await screen.findByLabelText(instructionLabel)).toHaveProperty('value', '保留这份指令');
    expect(screen.getByLabelText('目标助手').textContent).toContain('Codex');
    expect(screen.getByLabelText('模型')).toHaveProperty('value', 'custom-model');
    const preparing = screen.getByRole('button', { name: '正在整理会话上下文…' });
    expect(preparing).toHaveProperty('disabled', true);
    fireEvent.click(preparing);
    expect(handOffPrepare).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(prepared));
    expect(await screen.findByLabelText('续接上下文摘录')).toHaveProperty('value', prepared.preview);
    expect(handOffCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: commitLabel }));
    await waitFor(() => expect(handOffCommit).toHaveBeenCalledWith('prep-1'));
  });

  it('retains a result that arrives with no view mounted and isolates other sessions', async () => {
    const pending = deferred<typeof prepared>();
    handOffPrepare.mockReturnValueOnce(pending.promise);
    const view = render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '生成续接上下文' }));
    await waitFor(() => expect(handOffPrepare).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => pending.resolve(prepared));
    const other = render(<HandOffPreviewDialog open session={otherSource} onClose={vi.fn()} />);
    await screen.findByLabelText(instructionLabel);
    expect(screen.queryByLabelText('续接上下文摘录')).toBeNull();
    fireEvent.change(screen.getByLabelText(instructionLabel), { target: { value: '另一个会话' } });
    other.rerender(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    expect(await screen.findByLabelText('续接上下文摘录')).toHaveProperty('value', prepared.preview);
    expect(screen.getByLabelText(instructionLabel)).not.toHaveProperty('value', '另一个会话');
    expect(handOffCancel).not.toHaveBeenCalled();
  });

  it('keeps a ready preview when the same mounted parent hides and reopens the dialog', async () => {
    const view = render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '生成续接上下文' }));
    await screen.findByLabelText('续接上下文摘录');
    view.rerender(<HandOffPreviewDialog open={false} session={source} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    view.rerender(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    await screen.findByLabelText('续接上下文摘录');
    expect(screen.getByRole('button', { name: commitLabel })).toHaveProperty('disabled', false);
    expect(handOffPrepare).toHaveBeenCalledOnce();
    expect(handOffCancel).not.toHaveBeenCalled();
  });

  it('retains a background failure and allows retry with the same instruction', async () => {
    const pending = deferred<typeof prepared>();
    handOffPrepare.mockReturnValueOnce(pending.promise);
    const view = render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText(instructionLabel), { target: { value: '重试仍用此指令' } });
    fireEvent.click(screen.getByRole('button', { name: '生成续接上下文' }));
    await waitFor(() => expect(handOffPrepare).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => pending.reject(new Error('temporary preparation failure')));
    render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    await screen.findByText(/temporary preparation failure/);
    fireEvent.click(screen.getByRole('button', { name: '生成续接上下文' }));
    await screen.findByLabelText('续接上下文摘录');
    expect(handOffPrepare).toHaveBeenLastCalledWith(expect.objectContaining({
      continuationInstruction: '重试仍用此指令',
    }));
  });

  it('only cancels a retained preparation when explicitly abandoned', async () => {
    const onClose = vi.fn();
    const view = render(<HandOffPreviewDialog open session={source} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: '生成续接上下文' }));
    await screen.findByLabelText('续接上下文摘录');
    fireEvent.click(screen.getByRole('button', { name: '放弃本次接力' }));
    await waitFor(() => expect(handOffCancel).toHaveBeenCalledWith('prep-1'));
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    await screen.findByLabelText(instructionLabel);
    expect(screen.queryByLabelText('续接上下文摘录')).toBeNull();
  });

  it('clears an expired preparation without losing the editable draft', async () => {
    handOffCommit.mockRejectedValueOnce(new Error('Continuation preparation not found or not authorized'));
    const view = render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText(instructionLabel), { target: { value: '保留过期前的指令' } });
    fireEvent.click(screen.getByRole('button', { name: '生成续接上下文' }));
    await screen.findByLabelText('续接上下文摘录');
    view.unmount();
    render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: commitLabel }));
    await screen.findByText(/创建续接会话失败/);
    expect(screen.queryByLabelText('续接上下文摘录')).toBeNull();
    expect(screen.getByLabelText(instructionLabel)).toHaveProperty('value', '保留过期前的指令');
    fireEvent.click(screen.getByRole('button', { name: '生成续接上下文' }));
    await screen.findByLabelText('续接上下文摘录');
    expect(handOffPrepare).toHaveBeenCalledTimes(2);
  });

  it('keeps commit single-flight across remount and retains late cleanup failures', async () => {
    const pending = deferred<Awaited<ReturnType<Window['api']['handOffCommit']>>>();
    handOffCommit.mockReturnValueOnce(pending.promise);
    const view = render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '生成续接上下文' }));
    await screen.findByLabelText('续接上下文摘录');
    fireEvent.click(screen.getByRole('button', { name: commitLabel }));
    view.unmount();
    render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    const commit = await screen.findByRole('button', { name: '正在创建续接会话…' });
    expect(commit).toHaveProperty('disabled', true);
    fireEvent.click(commit);
    expect(handOffCommit).toHaveBeenCalledOnce();
    await act(async () => pending.resolve({
      status: 'execution-error', stage: 'transfer', successorSessionId: 'orphan-successor',
      successorCleanup: 'failed', usedLowerBudgetRetry: false, message: 'transfer failed',
    }));
    expect((await screen.findByRole('alert')).textContent).toContain('刚创建的续接会话');
    expect(screen.getByRole('button', { name: '生成续接上下文' })).toHaveProperty('disabled', true);
  });
});
