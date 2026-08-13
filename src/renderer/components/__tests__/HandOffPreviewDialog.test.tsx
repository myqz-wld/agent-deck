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
  target: {
    adapter: 'codex-cli',
    provider: null,
    model: 'gpt-custom',
    thinking: 'ultra',
  },
};

let handOffPrepare: ReturnType<typeof vi.fn>;
let handOffCommit: ReturnType<typeof vi.fn>;
let handOffCancel: ReturnType<typeof vi.fn>;

beforeEach(() => {
  handOffPrepare = vi.fn().mockResolvedValue(prepared);
  handOffCommit = vi.fn().mockResolvedValue({
    status: 'success',
    successorSessionId: 'target-1',
    cutoverEventRevision: 42,
    lateMessagesDelivered: 0,
    usedLowerBudgetRetry: false,
    sourceFinalizationWarning: null,
  });
  handOffCancel = vi.fn().mockResolvedValue(true);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      listClaudeGatewayProfiles: vi.fn().mockResolvedValue([]),
      listCodexModelProviders: vi.fn().mockResolvedValue([]),
      listAdapters: vi.fn().mockResolvedValue([
        { id: 'claude-code', displayName: 'Claude', capabilities: { canCreateSession: true } },
        { id: 'codex-cli', displayName: 'Codex', capabilities: { canCreateSession: true } },
        {
          id: 'grok-build',
          displayName: 'Grok Build',
          capabilities: { canCreateSession: true, canSetSessionMode: true },
          sessionModes: ['default', 'plan', 'ask'],
        },
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

    fireEvent.click(await screen.findByLabelText('目标助手'));
    fireEvent.click(screen.getByRole('option', { name: 'Codex' }));
    fireEvent.change(await screen.findByLabelText('模型来源'), {
      target: { value: 'openai-custom' },
    });
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
        target: {
          adapter: 'codex-cli',
          provider: 'openai-custom',
          model: 'gpt-custom',
          thinking: 'ultra',
        },
      });
    });
    const preview = await screen.findByLabelText('续接上下文摘录');
    expect(preview).toHaveProperty('readOnly', true);

    fireEvent.click(screen.getByRole('button', { name: '打开新会话接力' }));
    await waitFor(() => expect(handOffCommit).toHaveBeenCalledWith('prep-1'));
    expect(handOffCommit.mock.calls[0]).toHaveLength(1);
    expect(onClose).toHaveBeenCalled();
  });

  it('cancels and clears a preparation when the instruction changes', async () => {
    render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '生成续接上下文' }));
    await screen.findByLabelText('续接上下文摘录');

    fireEvent.change(screen.getByLabelText('下一步指令 / 补充与修正'), {
      target: { value: '修正后的指令' },
    });

    await waitFor(() => expect(handOffCancel).toHaveBeenCalledWith('prep-1'));
    expect(screen.queryByLabelText('续接上下文摘录')).toBeNull();
    expect(
      (screen.getByRole('button', { name: '打开新会话接力' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('prepares a Grok Build handoff with its own requested sandbox profile', async () => {
    render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText('目标助手'));
    fireEvent.click(screen.getByRole('option', { name: 'Grok Build' }));
    fireEvent.click(screen.getByLabelText('Grok Build 沙盒请求档位'));
    fireEvent.click(screen.getByRole('option', { name: '自定义配置…' }));
    fireEvent.change(screen.getByPlaceholderText('输入自定义 sandbox.toml 配置名称'), {
      target: { value: 'project-locked' },
    });
    fireEvent.change(screen.getByLabelText('下一步指令 / 补充与修正'), {
      target: { value: '由 Grok Build 继续。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '生成续接上下文' }));

    await waitFor(() => {
      expect(handOffPrepare).toHaveBeenCalledWith({
        sourceSessionId: 'source-1',
        continuationInstruction: '由 Grok Build 继续。',
        target: {
          adapter: 'grok-build',
          model: null,
          thinking: null,
          sessionMode: 'default',
          grokSandbox: 'project-locked',
        },
      });
    });
  });

  it('keeps the dialog visible when the successor exists but source finalization failed', async () => {
    const onClose = vi.fn();
    handOffCommit.mockResolvedValueOnce({
      status: 'success',
      successorSessionId: 'target-warning',
      cutoverEventRevision: 43,
      lateMessagesDelivered: 1,
      usedLowerBudgetRetry: false,
      sourceFinalizationWarning: '关闭源会话失败',
    });
    render(<HandOffPreviewDialog open session={source} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: '生成续接上下文' }));
    await screen.findByLabelText('续接上下文摘录');

    fireEvent.click(screen.getByRole('button', { name: '打开新会话接力' }));

    expect(
      await screen.findByText(/新会话已创建，但源会话收尾失败/),
    ).toBeTruthy();
    expect(screen.getByText(/新会话不会回滚；请检查源会话状态/)).toBeTruthy();
    expect(screen.queryByText(/关闭源会话失败/)).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('续接上下文摘录')).toBeNull();
  });

  it('retains orphan identity and blocks blind retry when successor cleanup fails', async () => {
    const onClose = vi.fn();
    handOffCommit.mockResolvedValueOnce({
      status: 'execution-error',
      stage: 'cutover',
      successorSessionId: 'orphan-successor-42',
      successorCleanup: 'failed',
      usedLowerBudgetRetry: false,
      message: 'Source changed while the successor was being created',
    });
    render(<HandOffPreviewDialog open session={source} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: '生成续接上下文' }));
    await screen.findByLabelText('续接上下文摘录');

    fireEvent.click(screen.getByRole('button', { name: '打开新会话接力' }));

    const warning = await screen.findByRole('alert');
    expect(warning.textContent).not.toContain('orphan-successor-42');
    expect(warning.textContent).toContain('源会话切换未完成');
    expect(warning.textContent).toContain('未能自动关闭');
    expect(warning.textContent).not.toContain('阶段：');
    expect(warning.textContent).not.toContain('清理状态：');
    expect(warning.textContent).toContain('请先在会话列表中找到并关闭刚创建的续接会话');
    expect(screen.queryByLabelText('续接上下文摘录')).toBeNull();
    expect(
      (screen.getByRole('button', { name: '生成续接上下文' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('button', { name: '我已检查会话列表，允许重新生成' }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      (screen.getByRole('button', { name: '生成续接上下文' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('blocks retry while startup cleanup is pending and never invents a session id', async () => {
    handOffCommit.mockResolvedValueOnce({
      status: 'execution-error',
      stage: 'cutover',
      successorSessionId: null,
      successorCleanup: 'pending',
      usedLowerBudgetRetry: true,
      cutoverReason: 'target-startup-timeout',
      message: 'startup deadline expired',
    });
    render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '生成续接上下文' }));
    await screen.findByLabelText('续接上下文摘录');
    fireEvent.click(screen.getByRole('button', { name: '打开新会话接力' }));

    const warning = await screen.findByRole('alert');
    expect(warning.textContent).toContain('续接会话启动超时');
    expect(warning.textContent).toContain('自动尝试关闭');
    expect(warning.textContent).toContain('已尝试使用较小范围的续接上下文');
    expect(warning.textContent).not.toContain('null');
    expect(
      (screen.getByRole('button', { name: '生成续接上下文' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole('button', { name: '我已检查会话列表，允许重新生成' }),
    );
  });

  it('reports a pre-creation deadline without promising late cleanup', async () => {
    handOffCommit.mockResolvedValueOnce({
      status: 'execution-error',
      stage: 'cutover',
      successorSessionId: null,
      successorCleanup: 'ok',
      usedLowerBudgetRetry: false,
      cutoverReason: 'target-startup-timeout',
      message: 'private deadline detail',
    });
    render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '生成续接上下文' }));
    await screen.findByLabelText('续接上下文摘录');
    fireEvent.click(screen.getByRole('button', { name: '打开新会话接力' }));

    const warning = await screen.findByRole('alert');
    expect(warning.textContent).toContain('未能在准备时限内生成可用会话');
    expect(warning.textContent).not.toContain('自动尝试关闭');
    expect(warning.textContent).not.toContain('private deadline detail');
    expect(
      (screen.getByRole('button', { name: '生成续接上下文' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      screen.queryByRole('button', { name: '我已检查会话列表，允许重新生成' }),
    ).toBeNull();
  });

  it('shows a safe terminal lower-budget startup failure without an orphan interlock', async () => {
    handOffCommit.mockResolvedValueOnce({
      status: 'execution-error',
      stage: 'cutover',
      successorSessionId: null,
      successorCleanup: 'ok',
      usedLowerBudgetRetry: true,
      cutoverReason: 'target-retry-startup-failed',
      message: 'private provider startup detail',
    });
    render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '生成续接上下文' }));
    await screen.findByLabelText('续接上下文摘录');
    fireEvent.click(screen.getByRole('button', { name: '打开新会话接力' }));

    const warning = await screen.findByRole('alert');
    expect(warning.textContent).toContain('较小范围的续接会话未能启动');
    expect(warning.textContent).toContain('已尝试使用较小范围的续接上下文');
    expect(warning.textContent).not.toContain('private provider startup detail');
    expect(warning.textContent).not.toContain('null');
    expect(
      (screen.getByRole('button', { name: '生成续接上下文' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      screen.queryByRole('button', { name: '我已检查会话列表，允许重新生成' }),
    ).toBeNull();
  });

  it('shows an actionable cause when late-message delivery fails', async () => {
    handOffCommit.mockResolvedValueOnce({
      status: 'execution-error',
      stage: 'cutover',
      successorSessionId: 'orphan-delivery-1',
      successorCleanup: 'ok',
      usedLowerBudgetRetry: true,
      cutoverReason: 'late-message-delivery-failed',
      message: 'late delivery failed',
    });
    render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '生成续接上下文' }));
    await screen.findByLabelText('续接上下文摘录');
    fireEvent.click(screen.getByRole('button', { name: '打开新会话接力' }));

    const warning = await screen.findByRole('alert');
    expect(warning.textContent).toContain('新增消息未能转交');
    expect(warning.textContent).toContain('已尝试使用较小范围的续接上下文');
    expect(warning.textContent).toContain('可能已经执行');
    expect(warning.textContent).toContain('重试可能造成重复执行');
    expect(warning.textContent).not.toContain('消息队列');
  });

  it('retains the orphan interlock across close, session navigation, and reopen', async () => {
    handOffCommit.mockResolvedValueOnce({
      status: 'execution-error',
      stage: 'transfer',
      successorSessionId: 'orphan-persistent-7',
      successorCleanup: 'failed',
      usedLowerBudgetRetry: false,
      message: 'internal transfer detail',
    });
    const onClose = vi.fn();
    const view = render(<HandOffPreviewDialog open session={source} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: '生成续接上下文' }));
    await screen.findByLabelText('续接上下文摘录');
    fireEvent.click(screen.getByRole('button', { name: '打开新会话接力' }));
    expect((await screen.findByRole('alert')).textContent).not.toContain('orphan-persistent-7');

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalled();
    view.rerender(<HandOffPreviewDialog open={false} session={source} onClose={onClose} />);
    view.rerender(<HandOffPreviewDialog open session={otherSource} onClose={onClose} />);
    expect(screen.queryByRole('alert')).toBeNull();
    view.rerender(<HandOffPreviewDialog open={false} session={otherSource} onClose={onClose} />);
    view.rerender(<HandOffPreviewDialog open session={source} onClose={onClose} />);

    const restored = await screen.findByRole('alert');
    expect(restored.textContent).toContain('刚创建的续接会话');
    expect(restored.textContent).not.toContain('orphan-persistent-7');
    expect(
      (screen.getByRole('button', { name: '生成续接上下文' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole('button', { name: '我已检查会话列表，允许重新生成' }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows explicit degradation and truncation information without making history editable', async () => {
    handOffPrepare.mockResolvedValueOnce({
      ...prepared,
      previewTruncated: true,
      quality: 'coverage-gap',
      warnings: [
        { code: 'coverage-gap', message: 'internal provider-neutral warning' },
        { code: 'raw-boundary-truncated', message: 'internal byte boundary' },
        { code: 'raw-history-omitted', message: 'internal retention budget' },
        { code: 'checkpoint-omitted', message: 'internal projection budget' },
        { code: 'spool-resource-guard', message: 'internal snapshot cap' },
        { code: 'future-warning-code', message: 'future internal detail' },
      ],
    });
    render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '生成续接上下文' }));

    expect(await screen.findByText(/节选已截短/)).toBeTruthy();
    expect(screen.getAllByText(/实际发送给模型的内容可能更完整/)).toHaveLength(2);
    expect(screen.getByText('部分历史内容未包含在本次续接上下文中。')).toBeTruthy();
    expect(screen.getByText('最早保留的一条用户消息只包含末尾部分。')).toBeTruthy();
    expect(screen.getByText('较早的部分消息未包含在本次续接上下文中。')).toBeTruthy();
    expect(screen.getByText('续接摘要过长，未能包含在本次上下文中。')).toBeTruthy();
    expect(screen.getByText('历史内容超过处理上限，节选中已标出未覆盖范围。')).toBeTruthy();
    expect(screen.getByText(/部分历史未包含/)).toBeTruthy();
    expect(screen.queryByText(/future-warning-code/)).toBeNull();
    expect(screen.queryByText(/future internal detail/)).toBeNull();
  });

  it('keeps the full next-step draft across compact and expanded editing', async () => {
    render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    await screen.findByLabelText('目标助手');
    const longInstruction = `先检查迁移\n${'继续执行并验证。'.repeat(500)}`;
    fireEvent.change(screen.getByLabelText('下一步指令 / 补充与修正'), {
      target: { value: longInstruction },
    });
    const compact = screen.getByLabelText('下一步指令 / 补充与修正');
    const trigger = screen.getByRole('button', { name: '展开编辑下一步指令' });
    expect(compact.className).toContain('resize-none');
    expect(compact.className).not.toContain('resize-y');
    expect(trigger.className).toContain('h-6');
    expect(trigger.className).toContain('w-6');
    expect(trigger.className).not.toContain('h-11');
    fireEvent.click(trigger);
    const expanded = screen.getByLabelText(
      '下一步指令 / 补充与修正（展开编辑）',
    ) as HTMLTextAreaElement;
    expect(expanded.value).toBe(longInstruction);
    fireEvent.change(expanded, {
      target: { value: `${longInstruction}\n最后运行完整测试。` },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '编辑下一步指令' })).toBeNull();
    });
    expect(
      (screen.getByLabelText('下一步指令 / 补充与修正') as HTMLTextAreaElement).value,
    ).toBe(`${longInstruction}\n最后运行完整测试。`);

    fireEvent.click(screen.getByRole('button', { name: '生成续接上下文' }));
    await waitFor(() => {
      expect(handOffPrepare).toHaveBeenCalledWith(expect.objectContaining({
        continuationInstruction: `${longInstruction}\n最后运行完整测试。`,
      }));
    });
  });

  it('labels the bounded preview as a read-only inline excerpt', async () => {
    handOffPrepare.mockResolvedValueOnce({
      ...prepared,
      preview: '受限摘录第一行\n受限摘录第二行',
    });
    render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '生成续接上下文' }));

    expect(await screen.findByText('会话续接上下文摘录（只读）')).toBeTruthy();
    expect(screen.getByText(
      '这里仅展示有长度上限的节选；实际发送给模型的内容可能更完整。',
    )).toBeTruthy();
    expect(screen.getByText(
      /上下文整理方式由“会话续接上下文”设置控制；下方选项只决定新会话使用的助手、模型和思考程度/,
    )).toBeTruthy();
    expect(screen.queryByText(/renderer|主进程|prompt/)).toBeNull();
    const excerpt = screen.getByLabelText('续接上下文摘录') as HTMLTextAreaElement;
    expect(excerpt.className).toContain('resize-y');
    expect(excerpt.readOnly).toBe(true);
    expect(excerpt.value).toBe('受限摘录第一行\n受限摘录第二行');
    expect(screen.queryByRole('button', {
      name: '展开查看续接上下文摘录',
    })).toBeNull();
  });

});
