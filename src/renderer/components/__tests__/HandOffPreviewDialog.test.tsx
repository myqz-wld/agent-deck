// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SessionHandOffPreparation, SessionRecord } from '@shared/types';
import { HandOffPreviewDialog } from '../HandOffPreviewDialog';

const source: SessionRecord = {
  id: 'source-1',
  agentId: 'claude-code',
  cwd: '/repo',
  title: 'Source',
  source: 'sdk',
  lifecycle: 'active',
  activity: 'idle',
  startedAt: 1,
  lastEventAt: 2,
  endedAt: null,
  archivedAt: null,
  model: 'sonnet',
  thinking: 'high',
};

const otherSource: SessionRecord = {
  ...source,
  id: 'source-2',
  title: 'Other source',
};

const prepared: SessionHandOffPreparation = {
  preparationId: 'prep-1',
  preview: '只读的会话续接上下文',
  previewTruncated: false,
  quality: 'full',
  source: { eventRevision: 42, rebuildAfterRevision: 0 },
  checkpoint: { id: 7, throughRevision: 42, formatVersion: 1, refreshed: true },
  metrics: {
    estimatedPromptTokens: 1_234,
    checkpointTokens: 300,
    rawTailTokens: 700,
    includedUserMessages: 4,
    truncatedBoundaryMessages: 0,
    rawRetentionCeilingTokens: 64_000,
    elapsedMs: 120,
  },
  warnings: [],
  target: { adapter: 'codex-cli', model: 'gpt-custom', thinking: 'ultra' },
};

let handOffPrepare: ReturnType<typeof vi.fn>;
let handOffCommit: ReturnType<typeof vi.fn>;
let handOffCancel: ReturnType<typeof vi.fn>;

beforeEach(() => {
  handOffPrepare = vi.fn().mockResolvedValue(prepared);
  handOffCommit = vi.fn().mockResolvedValue({
    status: 'success',
    successorSessionId: 'target-1',
    sourceFinalizationWarning: null,
  });
  handOffCancel = vi.fn().mockResolvedValue(true);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      listAdapters: vi.fn().mockResolvedValue([
        { id: 'claude-code', displayName: 'Claude', capabilities: { canCreateSession: true } },
        { id: 'codex-cli', displayName: 'Codex', capabilities: { canCreateSession: true } },
      ]),
      handOffPrepare,
      handOffCommit,
      handOffCancel,
    } as unknown as Window['api'],
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('HandOffPreviewDialog unified preparation flow', () => {
  it('selects the target before prepare and commits only the opaque preparation id', async () => {
    const onClose = vi.fn();
    render(<HandOffPreviewDialog open session={source} onClose={onClose} />);

    fireEvent.click(await screen.findByLabelText('目标 adapter'));
    fireEvent.click(screen.getByRole('option', { name: 'Codex' }));
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'gpt-custom' } });
    fireEvent.click(screen.getByLabelText('思考程度'));
    fireEvent.click(screen.getByRole('option', { name: 'ULTRA' }));
    fireEvent.change(screen.getByLabelText('下一步指令 / 补充与修正'), {
      target: { value: '继续完成迁移并运行测试。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '生成续接上下文' }));

    await waitFor(() => {
      expect(handOffPrepare).toHaveBeenCalledWith({
        sourceSessionId: 'source-1',
        continuationInstruction: '继续完成迁移并运行测试。',
        target: { adapter: 'codex-cli', model: 'gpt-custom', thinking: 'ultra' },
      });
    });
    const preview = await screen.findByLabelText('续接上下文预览');
    expect(preview).toHaveProperty('readOnly', true);

    fireEvent.click(screen.getByRole('button', { name: '打开新会话接力' }));
    await waitFor(() => expect(handOffCommit).toHaveBeenCalledWith('prep-1'));
    expect(handOffCommit.mock.calls[0]).toHaveLength(1);
    expect(onClose).toHaveBeenCalled();
  });

  it('cancels and clears a preparation when the instruction changes', async () => {
    render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '生成续接上下文' }));
    await screen.findByLabelText('续接上下文预览');

    fireEvent.change(screen.getByLabelText('下一步指令 / 补充与修正'), {
      target: { value: '修正后的指令' },
    });

    await waitFor(() => expect(handOffCancel).toHaveBeenCalledWith('prep-1'));
    expect(screen.queryByLabelText('续接上下文预览')).toBeNull();
    expect(
      (screen.getByRole('button', { name: '打开新会话接力' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('keeps the dialog visible when the successor exists but source finalization failed', async () => {
    const onClose = vi.fn();
    handOffCommit.mockResolvedValueOnce({
      status: 'success',
      successorSessionId: 'target-warning',
      sourceFinalizationWarning: '关闭源会话失败',
    });
    render(<HandOffPreviewDialog open session={source} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: '生成续接上下文' }));
    await screen.findByLabelText('续接上下文预览');

    fireEvent.click(screen.getByRole('button', { name: '打开新会话接力' }));

    expect(
      await screen.findByText(/新会话 target-warning 已创建，但源会话收尾失败/),
    ).toBeTruthy();
    expect(screen.getByText(/新会话不会回滚；请检查源会话状态/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('续接上下文预览')).toBeNull();
  });

  it('retains orphan identity and blocks blind retry when successor cleanup fails', async () => {
    const onClose = vi.fn();
    handOffCommit.mockResolvedValueOnce({
      status: 'execution-error',
      stage: 'cutover',
      successorSessionId: 'orphan-successor-42',
      successorCleanup: 'failed',
      message: 'Source changed while the successor was being created',
    });
    render(<HandOffPreviewDialog open session={source} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: '生成续接上下文' }));
    await screen.findByLabelText('续接上下文预览');

    fireEvent.click(screen.getByRole('button', { name: '打开新会话接力' }));

    const warning = await screen.findByRole('alert');
    expect(warning.textContent).toContain('orphan-successor-42');
    expect(warning.textContent).toContain('阶段：源会话切换前检查');
    expect(warning.textContent).toContain('清理状态：自动关闭失败');
    expect(warning.textContent).toContain('请先找到并关闭会话 orphan-successor-42');
    expect(screen.queryByLabelText('续接上下文预览')).toBeNull();
    expect(
      (screen.getByRole('button', { name: '生成续接上下文' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('button', { name: '我已关闭该会话，允许重新生成' }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      (screen.getByRole('button', { name: '生成续接上下文' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('retains the orphan interlock across close, session navigation, and reopen', async () => {
    handOffCommit.mockResolvedValueOnce({
      status: 'execution-error',
      stage: 'transfer',
      successorSessionId: 'orphan-persistent-7',
      successorCleanup: 'failed',
      message: 'internal transfer detail',
    });
    const onClose = vi.fn();
    const view = render(<HandOffPreviewDialog open session={source} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: '生成续接上下文' }));
    await screen.findByLabelText('续接上下文预览');
    fireEvent.click(screen.getByRole('button', { name: '打开新会话接力' }));
    expect((await screen.findByRole('alert')).textContent).toContain('orphan-persistent-7');

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalled();
    view.rerender(<HandOffPreviewDialog open={false} session={source} onClose={onClose} />);
    view.rerender(<HandOffPreviewDialog open session={otherSource} onClose={onClose} />);
    expect(screen.queryByRole('alert')).toBeNull();
    view.rerender(<HandOffPreviewDialog open={false} session={otherSource} onClose={onClose} />);
    view.rerender(<HandOffPreviewDialog open session={source} onClose={onClose} />);

    const restored = await screen.findByRole('alert');
    expect(restored.textContent).toContain('orphan-persistent-7');
    expect(
      (screen.getByRole('button', { name: '生成续接上下文' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole('button', { name: '我已关闭该会话，允许重新生成' }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows explicit degradation and truncation information without making history editable', async () => {
    handOffPrepare.mockResolvedValueOnce({
      ...prepared,
      previewTruncated: true,
      quality: 'coverage-gap',
      warnings: [{ code: 'coverage-gap', message: 'internal provider-neutral warning' }],
    });
    render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '生成续接上下文' }));

    expect(await screen.findByText(/预览已截断/)).toBeTruthy();
    expect(screen.getByText('部分事件修订未被续接检查点覆盖。')).toBeTruthy();
    expect(screen.getByText(/部分历史未覆盖/)).toBeTruthy();
  });
});
