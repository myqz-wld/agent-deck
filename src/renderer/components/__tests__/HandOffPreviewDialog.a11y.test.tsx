// @vitest-environment happy-dom
import { useState, type JSX } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionHandOffPreparation, SessionRecord } from '@shared/types';
import { HandOffPreviewDialog } from '../HandOffPreviewDialog';

const session = {
  id: 'source-a',
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
} as SessionRecord;

const preparation: SessionHandOffPreparation = {
  preparationId: 'prep-a',
  preview: '只读续接上下文',
  previewTruncated: false,
  quality: 'full',
  source: { eventRevision: 2, rebuildAfterRevision: 0 },
  checkpoint: { id: 1, throughRevision: 2, formatVersion: 1, refreshed: false },
  metrics: {
    estimatedPromptTokens: 10,
    checkpointTokens: 5,
    rawTailTokens: 5,
    includedUserMessages: 1,
    truncatedBoundaryMessages: 0,
    rawRetentionCeilingTokens: 1_000,
    elapsedMs: 1,
  },
  warnings: [],
  target: { adapter: 'claude-code', provider: null, model: null, thinking: null },
};

let handOffCommit: ReturnType<typeof vi.fn>;
let handOffCancel: ReturnType<typeof vi.fn>;

beforeEach(() => {
  handOffCommit = vi.fn().mockResolvedValue({
    status: 'success',
    successorSessionId: 'successor-a',
    cutoverEventRevision: 2,
    lateMessagesDelivered: 0,
    usedLowerBudgetRetry: false,
    sourceFinalizationWarning: null,
  });
  handOffCancel = vi.fn().mockResolvedValue(true);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      listAdapters: vi.fn().mockResolvedValue([
        { id: 'claude-code', displayName: 'Claude', capabilities: { canCreateSession: true } },
      ]),
      listClaudeGatewayProfiles: vi.fn().mockResolvedValue([]),
      listCodexModelProviders: vi.fn().mockResolvedValue([]),
      handOffPrepare: vi.fn().mockResolvedValue(preparation),
      handOffCommit,
      handOffCancel,
    } as unknown as Window['api'],
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

function Harness(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>打开接力</button>
      <HandOffPreviewDialog open={open} session={session} onClose={() => setOpen(false)} />
    </div>
  );
}

describe('HandOffPreviewDialog modal interaction', () => {
  it('traps and restores focus while a nested selector consumes the first Escape', async () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: '打开接力' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: '接力到新会话' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(dialog);

    const runtime = await screen.findByLabelText('目标运行时');
    fireEvent.click(runtime);
    fireEvent.keyDown(runtime, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(runtime.getAttribute('aria-expanded')).toBe('false');

    fireEvent.keyDown(runtime, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('does not close from Escape during an in-flight commit', async () => {
    let resolveCommit!: (value: Awaited<ReturnType<Window['api']['handOffCommit']>>) => void;
    handOffCommit.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCommit = resolve;
    }));
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '打开接力' }));
    fireEvent.click(await screen.findByRole('button', { name: '生成续接上下文' }));
    await screen.findByLabelText('续接上下文摘录');
    const commit = screen.getByRole('button', { name: '打开新会话接力' });
    fireEvent.click(commit);
    await waitFor(() => expect(handOffCommit).toHaveBeenCalledOnce());

    fireEvent.click(commit);
    expect(handOffCommit).toHaveBeenCalledOnce();
    const close = screen.getByRole('button', { name: '关闭接力窗口' }) as HTMLButtonElement;
    const cancel = screen.getByRole('button', { name: '取消' }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    fireEvent.click(close);
    fireEvent.click(cancel);
    expect(handOffCancel).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    await act(async () => resolveCommit({
      status: 'success',
      successorSessionId: 'successor-a',
      cutoverEventRevision: 2,
      lateMessagesDelivered: 0,
      usedLowerBudgetRetry: false,
      sourceFinalizationWarning: null,
    }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
