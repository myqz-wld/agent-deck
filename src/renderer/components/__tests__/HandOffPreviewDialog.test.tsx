// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SessionRecord } from '@shared/types';
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

let handOffSpawn: ReturnType<typeof vi.fn>;

beforeEach(() => {
  handOffSpawn = vi.fn().mockResolvedValue('target-1');
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      listAdapters: vi.fn().mockResolvedValue([
        { id: 'claude-code', displayName: 'Claude', capabilities: { canCreateSession: true } },
        { id: 'codex-cli', displayName: 'Codex', capabilities: { canCreateSession: true } },
      ]),
      handOffSummarize: vi.fn().mockResolvedValue({
        summary: '压缩后的接力上下文',
        contextQuality: 'full',
        summaryIncluded: true,
        includedMessageCount: 2,
        omittedMessageCount: 0,
        sourceCwd: '/repo',
        sourceAgentId: 'claude-code',
        sourcePermissionMode: null,
        sourceModel: 'sonnet',
        sourceThinking: 'high',
        sourceMaxEventId: 42,
      }),
      handOffSpawn,
    } as unknown as Window['api'],
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('HandOffPreviewDialog target runtime', () => {
  it('lets the user choose adapter, free-form model, and adapter-aware thinking', async () => {
    const onClose = vi.fn();
    render(<HandOffPreviewDialog open session={source} onClose={onClose} />);

    fireEvent.click(await screen.findByLabelText('目标 adapter'));
    fireEvent.click(screen.getByRole('option', { name: 'Codex' }));
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'gpt-custom' } });
    fireEvent.click(screen.getByLabelText('思考程度'));
    fireEvent.click(screen.getByRole('option', { name: 'ULTRA' }));
    fireEvent.click(screen.getByRole('button', { name: '✨ 开始总结' }));

    await screen.findByDisplayValue('压缩后的接力上下文');
    fireEvent.click(screen.getByRole('button', { name: '打开新会话接力' }));

    await waitFor(() => {
      expect(handOffSpawn).toHaveBeenCalledWith('source-1', {
        prompt: '压缩后的接力上下文',
        target: {
          adapter: 'codex-cli',
          model: 'gpt-custom',
          thinking: 'ultra',
        },
        expectedSourceMaxEventId: 42,
      });
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('warns when the checkpoint summary degraded to raw conversation', async () => {
    vi.mocked(window.api.handOffSummarize).mockResolvedValueOnce({
      summary: 'raw-only capsule',
      contextQuality: 'degraded',
      summaryIncluded: false,
      includedMessageCount: 3,
      omittedMessageCount: 1,
      sourceCwd: '/repo',
      sourceAgentId: 'claude-code',
      sourcePermissionMode: null,
      sourceModel: 'sonnet',
      sourceThinking: 'high',
      sourceMaxEventId: 42,
    });

    render(<HandOffPreviewDialog open session={source} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '✨ 开始总结' }));

    expect((await screen.findByText(/摘要模型未生成压缩检查点/)).textContent).toContain(
      '已保留最近 3 条原始对话',
    );
  });
});
