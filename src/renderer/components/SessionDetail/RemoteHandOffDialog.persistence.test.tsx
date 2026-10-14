// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import type { SessionHandOffCommitResult } from '@contracts/index';
import { remoteHandOffDrafts } from '../hand-off/remote-draft';
import { RemoteHandOffDialog } from './RemoteHandOffDialog';
import { deferred, preview, source } from './RemoteHandOffDialog.fixture';

afterEach(() => {
  cleanup();
  remoteHandOffDrafts.clear();
});

const instructionLabel = '下一步指令 / 补充与修正';
const commitLabel = '打开新会话接力';
const props = { sessionId: 'session-a', onClose: vi.fn(), onCommitted: vi.fn() };

async function generate(): Promise<void> {
  const button = await screen.findByRole('button', { name: '生成续接上下文' });
  await waitFor(() => expect(button).toHaveProperty('disabled', false));
  fireEvent.click(button);
}

describe('Remote handoff view lifetime', () => {
  it('preserves configuration and a pending preview across dismissal and remount', async () => {
    const pending = deferred<ReturnType<typeof preview>>();
    const current = source({ previewHandOff: vi.fn(() => pending.promise) });
    const view = render(<RemoteHandOffDialog {...props} source={current} />);
    fireEvent.change(await screen.findByLabelText(instructionLabel), { target: { value: '保留远端指令' } });
    fireEvent.click(screen.getByText('模型配置'));
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'remote-custom-model' } });
    await generate();
    expect(current.previewHandOff).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '暂时关闭' }));
    view.unmount();

    render(<RemoteHandOffDialog {...props} source={current} />);
    expect(await screen.findByLabelText(instructionLabel)).toHaveProperty('value', '保留远端指令');
    fireEvent.click(screen.getByText('模型配置'));
    expect(screen.getByLabelText('模型')).toHaveProperty('value', 'remote-custom-model');
    expect(screen.getByRole('button', { name: '正在整理会话上下文…' })).toHaveProperty('disabled', true);
    await act(async () => pending.resolve(preview()));
    await screen.findByLabelText('续接上下文摘录');
    fireEvent.click(screen.getByRole('button', { name: commitLabel }));
    await waitFor(() => expect(current.commitHandOff).toHaveBeenCalledWith(expect.objectContaining({
      continuationInstruction: '保留远端指令',
      target: expect.objectContaining({ options: expect.objectContaining({ model: 'remote-custom-model' }) }),
      expectedBindingDigest: preview().bindingDigest,
    })));
    expect(current.previewHandOff).toHaveBeenCalledOnce();
  });

  it('retains a background result while keeping session and source drafts separate', async () => {
    const pending = deferred<ReturnType<typeof preview>>();
    const current = source({ previewHandOff: vi.fn(() => pending.promise) });
    const view = render(<RemoteHandOffDialog {...props} source={current} />);
    await generate();
    view.unmount();
    await act(async () => pending.resolve(preview()));

    const other = render(<RemoteHandOffDialog {...props} source={current} sessionId="session-b" />);
    await screen.findByLabelText(instructionLabel);
    expect(screen.queryByLabelText('续接上下文摘录')).toBeNull();
    other.rerender(<RemoteHandOffDialog {...props} source={source({ identity: 'remote-b:core-b:1' })} />);
    await screen.findByLabelText(instructionLabel);
    expect(screen.queryByLabelText('续接上下文摘录')).toBeNull();
    other.rerender(<RemoteHandOffDialog {...props} source={current} />);
    expect(await screen.findByLabelText('续接上下文摘录')).toHaveProperty('value', preview().preview);
    expect(screen.getByRole('button', { name: commitLabel })).toHaveProperty('disabled', false);
  });

  it('revalidates restored options and invalidates a preview when capability defaults change', async () => {
    const current = source();
    const view = render(<RemoteHandOffDialog {...props} source={current} />);
    await generate();
    await screen.findByLabelText('续接上下文摘录');
    view.unmount();

    const descriptor = sessionConsoleCapabilitiesFixture('codex-cli', '.');
    descriptor.create.options.model = {
      ...descriptor.create.options.model, defaultValue: 'new-default-model',
    };
    render(<RemoteHandOffDialog {...props} source={{
      ...current, getSessionCapabilities: vi.fn(async () => descriptor),
    }} />);
    await screen.findByLabelText(instructionLabel);
    await waitFor(() => expect(screen.queryByLabelText('续接上下文摘录')).toBeNull());
    expect(screen.getByRole('button', { name: commitLabel })).toHaveProperty('disabled', true);
    expect(current.commitHandOff).not.toHaveBeenCalled();
  });

  it('restores terminal preview errors after unmount', async () => {
    let reject!: (cause: Error) => void;
    const current = source({ previewHandOff: vi.fn(() => new Promise<ReturnType<typeof preview>>(
      (_, fail) => { reject = fail; },
    )) });
    const view = render(<RemoteHandOffDialog {...props} source={current} />);
    await generate();
    view.unmount();
    await act(async () => reject(new Error('remote preview failed')));
    render(<RemoteHandOffDialog {...props} source={current} />);
    expect(await screen.findByText('remote preview failed')).toBeTruthy();
    expect(screen.getByRole('button', { name: '生成续接上下文' })).toHaveProperty('disabled', false);
  });

  it('does not duplicate a commit after remount and delivers its result to the current view', async () => {
    const pending = deferred<SessionHandOffCommitResult>();
    const current = source({ commitHandOff: vi.fn(() => pending.promise) });
    const oldCommitted = vi.fn();
    const onCommitted = vi.fn();
    const view = render(<RemoteHandOffDialog {...props} source={current} onCommitted={oldCommitted} />);
    await generate();
    await screen.findByLabelText('续接上下文摘录');
    fireEvent.click(screen.getByRole('button', { name: commitLabel }));
    view.unmount();
    render(<RemoteHandOffDialog {...props} source={current} onCommitted={onCommitted} />);
    const button = await screen.findByRole('button', { name: '正在创建续接会话…' });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(button);
    expect(current.commitHandOff).toHaveBeenCalledOnce();
    const result: SessionHandOffCommitResult = {
      successorSessionId: 'successor', cutoverEventRevision: 9, lateMessagesDelivered: 0,
      usedLowerBudgetRetry: false, sourceFinalizationWarning: null, revision: 10,
    };
    await act(async () => pending.resolve(result));
    await waitFor(() => expect(onCommitted).toHaveBeenCalledWith(result));
    expect(oldCommitted).not.toHaveBeenCalled();
  });
});
