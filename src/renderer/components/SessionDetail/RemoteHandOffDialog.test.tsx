// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  sessionConsoleCapabilitiesFixture,
  sessionConsoleCreateOptionsFixture,
} from '@contracts/session-console-capabilities.fixture';
import type { SessionHandOffPreviewResult } from '@contracts/index';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { RemoteHandOffDialog } from './RemoteHandOffDialog';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function preview(): SessionHandOffPreviewResult {
  return {
    bindingDigest: `sha256:${'b'.repeat(64)}`,
    preview: 'remote continuation preview',
    previewTruncated: false,
    quality: 'full',
    source: { eventRevision: 8, rebuildAfterRevision: 0 },
    checkpoint: { id: 1, throughRevision: 8, formatVersion: 2, refreshed: false },
    metrics: {
      estimatedPromptTokens: 120,
      checkpointTokens: 60,
      rawTailTokens: 60,
      includedUserMessages: 4,
      truncatedBoundaryMessages: 0,
      rawRetentionCeilingTokens: 1_000,
      elapsedMs: 4,
    },
    warnings: [],
    target: {
      adapterId: 'codex-cli',
      workingDirectory: 'repo',
      capabilityRevision: `sha256:${'a'.repeat(64)}`,
      options: sessionConsoleCreateOptionsFixture(),
    },
    revision: 9,
  };
}

function source(overrides: Partial<RemoteSessionSourceView> = {}): RemoteSessionSourceView {
  const descriptor = sessionConsoleCapabilitiesFixture('codex-cli', '.');
  return {
    identity: 'remote-a:core-a:1',
    usable: true,
    busy: false,
    capabilities: new Set(['session-console.read', 'sessions.handoff']),
    getSessionCapabilities: vi.fn(async () => descriptor),
    previewHandOff: vi.fn(async () => preview()),
    commitHandOff: vi.fn(async () => ({
      successorSessionId: 'session-successor',
      cutoverEventRevision: 9,
      lateMessagesDelivered: 0,
      usedLowerBudgetRetry: false,
      sourceFinalizationWarning: null,
      revision: 10,
    })),
    ...overrides,
  } as unknown as RemoteSessionSourceView;
}

describe('Remote handoff dialog authority', () => {
  it('uses Remote options, Core-owned inherited cwd, preview binding, and commit result', async () => {
    const current = source();
    const onCommitted = vi.fn();
    render(<RemoteHandOffDialog
      source={current}
      sessionId="session-a"
      onClose={vi.fn()}
      onCommitted={onCommitted}
    />);

    expect(screen.getByRole('heading', { name: '接力到新会话' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '接力到新会话' })).toBeTruthy();
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    const prepare = await screen.findByRole('button', { name: '生成续接上下文' });
    await waitFor(() => expect((prepare as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(prepare);

    await screen.findByText('remote continuation preview');
    expect(current.previewHandOff).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({
        adapterId: 'codex-cli',
        workingDirectory: null,
        capabilityRevision: null,
      }),
    }));
    fireEvent.click(screen.getByRole('button', { name: '确认接力' }));
    await waitFor(() => expect(current.commitHandOff).toHaveBeenCalledWith(
      expect.objectContaining({ expectedBindingDigest: `sha256:${'b'.repeat(64)}` }),
    ));
    await waitFor(() => expect(onCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ successorSessionId: 'session-successor' }),
    ));
  });

  it('does not apply an old preview after the session identity changes', async () => {
    let resolveOld!: (value: SessionHandOffPreviewResult) => void;
    const oldPreview = new Promise<SessionHandOffPreviewResult>((resolve) => {
      resolveOld = resolve;
    });
    const current = source({ previewHandOff: vi.fn(() => oldPreview) });
    const view = render(<RemoteHandOffDialog
      source={current}
      sessionId="session-a"
      onClose={vi.fn()}
      onCommitted={vi.fn()}
    />);
    const prepare = await screen.findByRole('button', { name: '生成续接上下文' });
    await waitFor(() => expect((prepare as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(prepare);
    await waitFor(() => expect(current.previewHandOff).toHaveBeenCalledOnce());

    view.rerender(<RemoteHandOffDialog
      source={current}
      sessionId="session-b"
      onClose={vi.fn()}
      onCommitted={vi.fn()}
    />);
    resolveOld(preview());
    await oldPreview;
    await Promise.resolve();

    expect(screen.queryByText('remote continuation preview')).toBeNull();
  });

  it('lets a nested runtime selector consume Escape before the modal closes', async () => {
    const onClose = vi.fn();
    render(<RemoteHandOffDialog
      source={source()}
      sessionId="session-a"
      onClose={onClose}
      onCommitted={vi.fn()}
    />);
    const runtime = (await screen.findByText('Codex CLI')).closest('button');
    if (!runtime) throw new Error('未找到 Remote 运行时选择器。');
    fireEvent.click(runtime);
    expect(runtime.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(runtime, { key: 'Escape' });
    expect(runtime.getAttribute('aria-expanded')).toBe('false');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(runtime, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps Escape blocked while a commit is in progress', async () => {
    let resolveCommit!: (value: Awaited<ReturnType<RemoteSessionSourceView['commitHandOff']>>) => void;
    const commitHandOff = vi.fn(() => new Promise<
      Awaited<ReturnType<RemoteSessionSourceView['commitHandOff']>>
    >((resolve) => { resolveCommit = resolve; }));
    const current = source({ commitHandOff });
    const onClose = vi.fn();
    render(<RemoteHandOffDialog
      source={current}
      sessionId="session-a"
      onClose={onClose}
      onCommitted={vi.fn()}
    />);
    const prepareButton = await screen.findByRole('button', { name: '生成续接上下文' });
    await waitFor(() => expect((prepareButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(prepareButton);
    await screen.findByText('remote continuation preview');
    fireEvent.click(screen.getByRole('button', { name: '确认接力' }));
    await waitFor(() => expect(commitHandOff).toHaveBeenCalledOnce());

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    resolveCommit({
      successorSessionId: 'session-successor',
      cutoverEventRevision: 9,
      lateMessagesDelivered: 0,
      usedLowerBudgetRetry: false,
      sourceFinalizationWarning: null,
      revision: 10,
    });
  });
});
