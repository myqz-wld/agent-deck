// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import { remoteSandboxOptions } from '@renderer/components/new-session/remote-sandbox-options';
import type { RemoteSessionSourceView } from './source-types';

const images = vi.hoisted(() => ({
  attachments: [{
    id: 'attachment-1',
    thumbnailDataUrl: 'data:image/png;base64,aGVsbG8=',
    mime: 'image/png',
    bytes: 5,
    name: 'evidence.png',
  }],
  error: null,
  add: vi.fn(),
  remove: vi.fn(),
  clear: vi.fn(),
  onPaste: vi.fn(),
  onDrop: vi.fn(),
  onDragOver: vi.fn(),
  toIpcInputs: vi.fn(() => [{
    kind: 'image', base64: 'aGVsbG8=', mime: 'image/png', bytes: 5,
  }]),
  snapshotForSend: vi.fn(),
  releasePayloads: vi.fn(),
  getPreviewDataUrl: vi.fn(() => 'data:image/png;base64,aGVsbG8='),
  dismissError: vi.fn(),
}));

vi.mock('@renderer/hooks/useImageAttachments', () => ({
  useImageAttachments: () => images,
}));

import { NewSessionDialog } from '@renderer/components/NewSessionDialog';

beforeEach(() => {
  images.toIpcInputs.mockImplementation(() => [{
    kind: 'image', base64: 'aGVsbG8=', mime: 'image/png', bytes: 5,
  }]);
  images.getPreviewDataUrl.mockImplementation(() => 'data:image/png;base64,aGVsbG8=');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function source(
  adapterId: 'claude-code' | 'codex-cli' | 'grok-build' = 'codex-cli',
): RemoteSessionSourceView {
  const descriptor = sessionConsoleCapabilitiesFixture(adapterId, '.');
  return {
    addressableIdentityKey: 'remote-a:core-a:1',
    busy: false,
    capabilities: new Set(['session-console.create', 'session-console.read']),
    dataRevision: 0,
    resourceRevisions: {
      'session-list': 0, 'session-detail': 0, pending: 0,
      issues: 0, usage: 0, 'node-configuration': 0, 'node-assets': 0,
    },
    error: null,
    eventLoadError: null,
    events: null,
    historyLoadError: null,
    historyLoading: false,
    historyPaginationBusy: false,
    historyArchivedOnly: false,
    historyQuery: '',
    historySessions: [],
    hasMoreHistorySessions: false,
    hasMoreSessions: false,
    identity: 'remote-a:core-a:1',
    loading: false,
    livePaginationBusy: false,
    pendingBuckets: [],
    pendingBySession: new Map(),
    pendingLoading: false,
    pendingPaginationBusy: false,
    pendingLoadError: null,
    pendingTotal: 0,
    pendingScanTruncated: false,
    hasMorePending: false,
    presentationCounts: null,
    profile: {
      id: 'remote-a',
      label: 'Primary Worker',
      scope: 'remote',
      endpoint: null,
    },
    recoveringWorker: false,
    runtime: null,
    runtimeLoadError: null,
    context: null,
    contextLoadError: null,
    inputCapabilities: null,
    inputLoadError: null,
    summaryLoadError: null,
    summaries: null,
    taskLoadError: null,
    tasks: null,
    sessionTotal: 0,
    selectedPending: null,
    selectedSession: null,
    selectedSessionId: null,
    sessions: [],
    state: null,
    usable: true,
    clearError: vi.fn(),
    archiveHistorySession: vi.fn(),
    createSession: vi.fn(async () => 'remote-session'),
    createWorkspaceDirectory: vi.fn(),
    deleteHistorySession: vi.fn(),
    getSessionCapabilities: vi.fn(async () => ({
      ...descriptor,
      create: {
        ...descriptor.create,
        attachments: {
          disabledReason: null,
          enabled: true,
          maxBytesEach: 2 * 1024 * 1024,
          maxBytesTotal: 2 * 1024 * 1024,
          maxCount: 4,
          mimeTypes: ['image/png'],
        },
      },
    })),
    listWorkspaceDirectories: vi.fn(),
    listFileChanges: vi.fn(),
    getFileChange: vi.fn(),
    getFileFinalDiff: vi.fn(),
    loadImageBlob: vi.fn(async () => ({ ok: false as const, reason: 'unsupported_source' as const })),
    planReviewTransport: vi.fn(() => null),
    interrupt: vi.fn(),
    previewHandOff: vi.fn(),
    commitHandOff: vi.fn(),
    loadMoreHistorySessions: vi.fn(),
    listOutgoing: vi.fn(async () => ({
      sessionId: 'session-a', adapterId: 'claude-code', messages: [], revision: 1,
    })),
    loadMorePending: vi.fn(),
    loadMoreSessions: vi.fn(),
    refresh: vi.fn(),
    respondPending: vi.fn(),
    removeOutgoing: vi.fn(async () => true),
    selectSession: vi.fn(),
    setHistoryQuery: vi.fn(),
    setHistoryArchivedOnly: vi.fn(),
    send: vi.fn(),
    steer: vi.fn(),
    updateRuntime: vi.fn(),
    unarchiveHistorySession: vi.fn(),
    reactivateSession: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Remote New Session attachments', () => {
  it('passes the retained image through the exact Remote create contract', async () => {
    const current = source();
    window.api = {} as typeof window.api;
    render(<NewSessionDialog open remoteSource={current} onClose={vi.fn()} onCreated={vi.fn()} />);

    await waitFor(() => expect(current.getSessionCapabilities).toHaveBeenCalled());
    await waitFor(() => expect(
      (screen.getByRole('button', { name: '创建' }) as HTMLButtonElement).disabled,
    ).toBe(false));
    expect(screen.getByRole('img', { name: 'evidence.png' })).toBeTruthy();
    expect(screen.getByText('创建目标：远端 · Primary Worker · 工作区')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(
      () => expect(current.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: [{ kind: 'image', base64: 'aGVsbG8=', mime: 'image/png', bytes: 5 }],
          capabilityRevision: `sha256:${'a'.repeat(64)}`,
          workingDirectory: '.',
        }),
      ),
      { timeout: 3_000 },
    );
    expect(images.clear).toHaveBeenCalledOnce();
  });

  it('describes Remote sandbox choices relative to the Workspace ceiling', async () => {
    const current = source();
    window.api = {} as typeof window.api;
    render(<NewSessionDialog open remoteSource={current} onClose={vi.fn()} onCreated={vi.fn()} />);

    const selected = await screen.findByTitle(
      '可读取远端工作区，但只能写入当前会话目录。',
    );
    expect(selected.textContent).toContain('工作目录可写');
  });

  it('keeps Local-equivalent Grok choices visible but disabled until Core has a container', () => {
    const reason = 'Remote Grok 需要 Provider 会话容器与 Core 凭证代理。';
    const options = remoteSandboxOptions([
      { value: 'read-only', effectiveAccess: 'workspace-read-only', enabled: false,
        disabledReason: reason },
      { value: 'workspace', effectiveAccess: 'selected-directory-read-write', enabled: false,
        disabledReason: reason },
      { value: 'off', effectiveAccess: 'workspace-read-write', enabled: false,
        disabledReason: reason },
    ], 'grokSandbox');

    expect(options).toEqual([
      expect.objectContaining({ label: '广泛只读', disabled: true, title: reason }),
      expect.objectContaining({ label: '工作目录可写', disabled: true, title: reason }),
      expect.objectContaining({ label: '⚠️ 工作区内完全开放', disabled: true, title: reason }),
    ]);
  });

  it('renders every adapter-native disabled option with the Core-provided reason', async () => {
    const current = source();
    const descriptor = sessionConsoleCapabilitiesFixture('codex-cli', '.');
    const disabledReason = '当前 Worker 策略不允许修改此选项。';
    vi.mocked(current.getSessionCapabilities).mockResolvedValue({
      ...descriptor,
      create: {
        ...descriptor.create,
        options: {
          ...descriptor.create.options,
          approvalPolicy: {
            allowedValues: [], allowCustom: false, allowEmpty: false,
            defaultValue: null, disabledReason, enabled: false,
          },
          provider: {
            allowedValues: [], allowCustom: false, allowEmpty: false,
            defaultValue: null, disabledReason, enabled: false,
          },
          model: {
            allowedValues: [], allowCustom: false, allowEmpty: false,
            defaultValue: null, disabledReason, enabled: false,
          },
        },
      },
    });
    window.api = {} as typeof window.api;
    render(<NewSessionDialog open remoteSource={current} onClose={vi.fn()} onCreated={vi.fn()} />);

    expect((await screen.findAllByText(`不可用：${disabledReason}`)).length)
      .toBeGreaterThanOrEqual(3);
    expect(screen.getByText('审批策略')).toBeTruthy();
  });

  it('does not restore stale create capabilities after a same-identity disconnect', async () => {
    const current = source();
    const pending = deferred<Awaited<ReturnType<typeof current.getSessionCapabilities>>>();
    vi.mocked(current.getSessionCapabilities).mockImplementation(() => pending.promise);
    window.api = {} as typeof window.api;
    const view = render(
      <NewSessionDialog open remoteSource={current} onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    await waitFor(() => expect(current.getSessionCapabilities).toHaveBeenCalledOnce());

    const disconnected = { ...current, usable: false };
    view.rerender(
      <NewSessionDialog open remoteSource={disconnected} onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    expect(await screen.findByText('当前远端版本暂未提供会话创建设置。')).toBeTruthy();

    const descriptor = sessionConsoleCapabilitiesFixture('codex-cli', '.');
    await act(async () => {
      pending.resolve({
        ...descriptor,
        create: {
          ...descriptor.create,
          attachments: {
            disabledReason: null,
            enabled: true,
            maxBytesEach: 2 * 1024 * 1024,
            maxBytesTotal: 2 * 1024 * 1024,
            maxCount: 4,
            mimeTypes: ['image/png'],
          },
        },
      });
      await pending.promise;
    });

    expect(screen.getByText('当前远端版本暂未提供会话创建设置。')).toBeTruthy();
    expect(screen.queryByText('Codex CLI')).toBeNull();

    const fresh = deferred<Awaited<ReturnType<typeof current.getSessionCapabilities>>>();
    vi.mocked(current.getSessionCapabilities).mockImplementationOnce(() => fresh.promise);
    view.rerender(
      <NewSessionDialog open remoteSource={current} onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    await waitFor(() => expect(current.getSessionCapabilities).toHaveBeenCalledTimes(2));
    expect(document.querySelector('[data-new-session-modal-root="true"]')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '新建会话' })).toBeNull();

    await act(async () => fresh.resolve({
      ...descriptor,
      create: {
        ...descriptor.create,
        attachments: {
          disabledReason: null,
          enabled: true,
          maxBytesEach: 2 * 1024 * 1024,
          maxBytesTotal: 2 * 1024 * 1024,
          maxCount: 4,
          mimeTypes: ['image/png'],
        },
      },
    }));
    expect(screen.getByText('Codex CLI')).toBeTruthy();
  });

  it('fences a Remote create completion when the same identity disconnects', async () => {
    const create = deferred<string>();
    const current = source();
    current.createSession = vi.fn(() => create.promise);
    const onCreated = vi.fn();
    window.api = {} as typeof window.api;
    const view = render(
      <NewSessionDialog open remoteSource={current} onClose={vi.fn()} onCreated={onCreated} />,
    );
    const createButton = await screen.findByRole('button', { name: '创建' });
    await waitFor(() => expect((createButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(createButton);
    await waitFor(() => expect(current.createSession).toHaveBeenCalledOnce());

    view.rerender(
      <NewSessionDialog
        open
        remoteSource={{ ...current, usable: false }}
        onClose={vi.fn()}
        onCreated={onCreated}
      />,
    );
    await act(async () => create.resolve('stale-session'));

    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByText('当前远端版本暂未提供会话创建设置。')).toBeTruthy();
  });
});
