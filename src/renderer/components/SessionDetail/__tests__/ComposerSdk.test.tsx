// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentEvent, PendingOutgoingMessage, SessionRecord } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import {
  imageAttachmentSidecarStats,
  resetImageAttachmentSidecarForTests,
  storeAttachmentPayload,
} from '@renderer/hooks/image-attachments/payload-sidecar';
import type { UploadedAttachmentEntry } from '@renderer/hooks/image-attachments/types';
import { ComposerSdk } from '../ComposerSdk';

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess-1',
    agentId: 'codex-cli',
    cwd: '/tmp/project',
    title: 'Codex',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1000,
    lastEventAt: 1000,
    endedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

let sendAdapterMessage: ReturnType<typeof vi.fn>;
let interruptAdapterSession: ReturnType<typeof vi.fn>;
let setSessionModelOptions: ReturnType<typeof vi.fn>;
let setAdapterSessionMode: ReturnType<typeof vi.fn>;
let setAdapterPermissionMode: ReturnType<typeof vi.fn>;
let listPendingOutgoingMessages: ReturnType<typeof vi.fn>;
let deletePendingOutgoingMessage: ReturnType<typeof vi.fn>;
let emitAgentEvent: (event: AgentEvent) => void;

beforeEach(() => {
  sendAdapterMessage = vi.fn(() => Promise.resolve());
  interruptAdapterSession = vi.fn(() => Promise.resolve());
  setSessionModelOptions = vi.fn(() => Promise.resolve());
  setAdapterSessionMode = vi.fn(() => Promise.resolve());
  setAdapterPermissionMode = vi.fn(() => Promise.resolve());
  listPendingOutgoingMessages = vi.fn<() => Promise<PendingOutgoingMessage[]>>(
    () => Promise.resolve([]),
  );
  deletePendingOutgoingMessage = vi.fn(() => Promise.resolve(true));
  resetImageAttachmentSidecarForTests();
  useSessionStore.setState({
    sessions: new Map(),
    composerBySession: new Map(),
    composerAliases: new Map(),
    composerRequestSequence: 0,
  });
  emitAgentEvent = () => undefined;
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      listAdapters: vi.fn().mockResolvedValue([
        {
          id: 'codex-cli',
          displayName: 'Codex CLI',
          capabilities: { canAcceptAttachments: true },
        },
      ]),
      listClaudeGatewayProfiles: vi.fn().mockResolvedValue([]),
      listCodexGatewayProfiles: vi.fn().mockResolvedValue([]),
      sendAdapterMessage,
      interruptAdapterSession,
      setSessionModelOptions,
      setAdapterSessionMode,
      setAdapterPermissionMode,
      listPendingOutgoingMessages,
      deletePendingOutgoingMessage,
      onAgentEvent: vi.fn((listener: (event: AgentEvent) => void) => {
        emitAgentEvent = listener;
        return vi.fn();
      }),
    } as unknown as Window['api'],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ComposerSdk unified input routing', () => {
  it('disables interrupt while idle and shows progress while cancellation is pending', async () => {
    let resolveInterrupt = (): void => undefined;
    interruptAdapterSession.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveInterrupt = resolve;
      }),
    );
    const view = render(<ComposerSdk session={makeSession()} turnBusy={false} />);
    const idleButton = screen.getByRole('button', { name: '中断' }) as HTMLButtonElement;
    expect(idleButton.disabled).toBe(true);
    expect(idleButton.title).toBe('当前没有运行中的任务');

    view.rerender(
      <ComposerSdk
        session={makeSession({ activity: 'working' })}
        turnBusy
      />,
    );
    const activeButton = screen.getByRole('button', { name: '中断' }) as HTMLButtonElement;
    expect(activeButton.disabled).toBe(false);
    fireEvent.click(activeButton);

    await waitFor(() => {
      const pending = screen.getByRole('button', { name: '中断中…' }) as HTMLButtonElement;
      expect(pending.disabled).toBe(true);
      expect(pending.title).toBe('正在中断当前任务');
    });
    expect(interruptAdapterSession).toHaveBeenCalledWith('codex-cli', 'sess-1');

    resolveInterrupt();
    view.rerender(<ComposerSdk session={makeSession()} turnBusy={false} />);
    await waitFor(() => expect(
      (screen.getByRole('button', { name: '中断' }) as HTMLButtonElement).disabled,
    ).toBe(true));
  });

  it('isolates and restores text, image descriptors, and errors by logical session', async () => {
    const view = render(<ComposerSdk session={makeSession({ id: 'session-A' })} />);
    const inputA = screen.getByPlaceholderText(/给 Codex CLI 发消息/) as HTMLTextAreaElement;
    fireEvent.change(inputA, { target: { value: 'draft A' } });
    const image: UploadedAttachmentEntry = {
      id: 'image-A',
      thumbnailDataUrl: 'data:image/gif;base64,R0lGODlhAQABAAD/ACw=',
      mime: 'image/png',
      bytes: 4,
    };
    storeAttachmentPayload('session-A', image.id, {
      base64: 'QUFBQQ==',
      mime: 'image/png',
      bytes: 4,
    });
    act(() => {
      useSessionStore.getState().updateComposer('session-A', (current) => ({
        ...current,
        attachments: [image],
        sendError: 'A send failed',
      }));
    });
    expect(screen.getByText(/A send failed/)).toBeTruthy();
    expect(screen.getByRole('img', { name: '附件图片 1' })).toBeTruthy();

    view.rerender(<ComposerSdk session={makeSession({ id: 'session-B' })} />);
    const inputB = screen.getByPlaceholderText(/给 Codex CLI 发消息/) as HTMLTextAreaElement;
    expect(inputB.value).toBe('');
    expect(screen.queryByText(/A send failed/)).toBeNull();
    expect(screen.queryByRole('img', { name: '附件图片 1' })).toBeNull();
    fireEvent.change(inputB, { target: { value: 'draft B' } });

    view.rerender(<ComposerSdk session={makeSession({ id: 'session-A' })} />);
    expect((screen.getByPlaceholderText(/给 Codex CLI 发消息/) as HTMLTextAreaElement).value)
      .toBe('draft A');
    expect(screen.getByText(/A send failed/)).toBeTruthy();
    expect(screen.getByRole('img', { name: '附件图片 1' })).toBeTruthy();

    view.rerender(<ComposerSdk session={makeSession({ id: 'session-B' })} />);
    expect((screen.getByPlaceholderText(/给 Codex CLI 发消息/) as HTMLTextAreaElement).value)
      .toBe('draft B');
  });

  it('restores a failed send only to its originating logical session', async () => {
    let rejectSend: (error: Error) => void = () => undefined;
    sendAdapterMessage.mockImplementationOnce(
      () => new Promise((_resolve, reject) => {
        rejectSend = reject;
      }),
    );
    const view = render(<ComposerSdk session={makeSession({ id: 'session-A' })} />);
    const inputA = screen.getByPlaceholderText(/给 Codex CLI 发消息/);
    fireEvent.change(inputA, { target: { value: 'send from A' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendAdapterMessage).toHaveBeenCalledWith(
      'codex-cli',
      'session-A',
      { text: 'send from A' },
    ));

    view.rerender(<ComposerSdk session={makeSession({ id: 'session-B' })} />);
    const inputB = screen.getByPlaceholderText(/给 Codex CLI 发消息/) as HTMLTextAreaElement;
    fireEvent.change(inputB, { target: { value: 'newer B draft' } });
    rejectSend(new Error('A failed'));
    await waitFor(() => expect(
      useSessionStore.getState().composerBySession.get('session-A')?.sendError,
    ).toBe('A failed'));
    expect(inputB.value).toBe('newer B draft');
    expect(screen.queryByText(/A failed/)).toBeNull();

    view.rerender(<ComposerSdk session={makeSession({ id: 'session-A' })} />);
    await waitFor(() => {
      expect((screen.getByPlaceholderText(/给 Codex CLI 发消息/) as HTMLTextAreaElement).value)
        .toBe('send from A');
      expect(screen.getByText(/A failed/)).toBeTruthy();
    });
  });

  it('releases an ignored temp-send snapshot after a newer target generation wins rename', async () => {
    let rejectSend: (error: Error) => void = () => undefined;
    sendAdapterMessage.mockImplementationOnce(
      () => new Promise((_resolve, reject) => {
        rejectSend = reject;
      }),
    );
    render(<ComposerSdk session={makeSession({ id: 'TEMP' })} />);
    act(() => useSessionStore.getState().ensureComposerSession('TEMP'));
    const image: UploadedAttachmentEntry = {
      id: 'temp-image',
      thumbnailDataUrl: 'data:image/gif;base64,R0lGODlhAQABAAD/ACw=',
      mime: 'image/png',
      bytes: 4,
    };
    storeAttachmentPayload('TEMP', image.id, {
      base64: 'VEVNUA==',
      mime: 'image/png',
      bytes: 4,
    });
    act(() => {
      useSessionStore.getState().updateComposer('TEMP', (current) => ({
        ...current,
        text: 'temporary send',
        attachments: [image],
      }));
    });
    await screen.findByRole('button', { name: '上传图片' });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendAdapterMessage).toHaveBeenCalledTimes(1));

    let targetGeneration = 0;
    act(() => {
      const state = useSessionStore.getState();
      state.ensureComposerSession('REAL');
      state.updateComposer('REAL', (current) => ({
        ...current,
        text: 'newer target draft',
      }));
      targetGeneration = state.beginComposerRequest('REAL', 'send')!;
      state.renameSession('TEMP', 'REAL');
    });
    expect(imageAttachmentSidecarStats().payloads).toBe(1);

    await act(async () => {
      rejectSend(new Error('stale source failure'));
      await Promise.resolve();
    });
    await waitFor(() => expect(imageAttachmentSidecarStats().payloads).toBe(0));
    expect(useSessionStore.getState().composerBySession.get('REAL')).toMatchObject({
      text: 'newer target draft',
      attachments: [],
      sendError: null,
      requests: { send: { generation: targetGeneration, busy: true } },
    });
  });

  it('keeps the expanded editor synchronized and closes it with Escape', async () => {
    render(<ComposerSdk session={makeSession()} />);
    const input = screen.getByPlaceholderText(/给 Codex CLI 发消息/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'inspect this draft' } });
    fireEvent.click(screen.getByRole('button', { name: '放大输入框' }));

    const dialog = screen.getByRole('dialog', { name: '放大消息输入框' });
    const expanded = within(dialog).getByPlaceholderText(/给 Codex CLI 发消息/) as HTMLTextAreaElement;
    expect(expanded.value).toBe('inspect this draft');
    fireEvent.change(expanded, { target: { value: 'edited in expanded view' } });
    expect(input.value).toBe('edited in expanded view');

    fireEvent.keyDown(expanded, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', {
      name: '放大消息输入框',
    })).toBeNull());
    expect(input.value).toBe('edited in expanded view');
  });

  it('shows the Codex image picker inside the expanded editor', async () => {
    render(<ComposerSdk session={makeSession()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '上传图片' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '放大输入框' }));

    const dialog = screen.getByRole('dialog', { name: '放大消息输入框' });
    expect(within(dialog).getByRole('button', { name: '上传图片' })).toBeTruthy();
    expect(dialog.className).toContain('no-drag');
  });

  it('isolates the expanded editor and traps keyboard focus until it closes', async () => {
    const { container } = render(<ComposerSdk session={makeSession()} />);
    const expand = screen.getByRole('button', { name: '放大输入框' });
    expand.focus();
    fireEvent.click(expand);
    const dialog = screen.getByRole('dialog', { name: '放大消息输入框' });
    const expanded = within(dialog).getByPlaceholderText(/给 Codex CLI 发消息/);
    const close = within(dialog).getByRole('button', { name: /关闭/ });

    expect(container.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).toBe(expanded);
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(expanded);
    expanded.focus();
    fireEvent.keyDown(expanded, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    fireEvent.click(close);
    await waitFor(() => expect(document.activeElement).toBe(expand));
    expect(container.getAttribute('aria-hidden')).toBeNull();
  });

  it('submits from the expanded editor but ignores IME Enter', async () => {
    render(<ComposerSdk session={makeSession()} />);
    fireEvent.change(screen.getByPlaceholderText(/给 Codex CLI 发消息/), {
      target: { value: 'expanded send' },
    });
    fireEvent.click(screen.getByRole('button', { name: '放大输入框' }));
    const dialog = screen.getByRole('dialog', { name: '放大消息输入框' });
    const expanded = within(dialog).getByPlaceholderText(/给 Codex CLI 发消息/);

    fireEvent.keyDown(expanded, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(sendAdapterMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(expanded, { key: 'Enter', isComposing: false, keyCode: 13 });

    await waitFor(() => expect(sendAdapterMessage).toHaveBeenCalledWith(
      'codex-cli',
      'sess-1',
      { text: 'expanded send' },
    ));
    await waitFor(() => expect(screen.queryByRole('dialog', {
      name: '放大消息输入框',
    })).toBeNull());
  });

  it('shows authoritative pending messages and deletes one before consumption', async () => {
    listPendingOutgoingMessages.mockResolvedValueOnce([
      {
        id: 'pending-1',
        text: 'queued request',
        attachments: [
          { id: '0', mime: 'image/png', bytes: 10 },
          { id: '1', mime: 'image/jpeg', bytes: 20 },
        ],
      },
    ]).mockResolvedValueOnce([]);
    render(<ComposerSdk session={makeSession()} />);

    expect(await screen.findByText(/queued request/)).toBeTruthy();
    expect(screen.getByText(/2 个附件/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '删除等待消息' }));

    await waitFor(() => expect(deletePendingOutgoingMessage).toHaveBeenCalledWith(
      'codex-cli',
      'sess-1',
      'pending-1',
    ));
    await waitFor(() => expect(screen.queryByText(/queued request/)).toBeNull());
  });

  it('removes a pending row when its correlated user event is consumed', async () => {
    listPendingOutgoingMessages.mockResolvedValueOnce([
      { id: 'pending-1', text: 'wait for provider', attachments: [] },
    ]).mockResolvedValueOnce([]);
    render(<ComposerSdk session={makeSession()} />);
    expect(await screen.findByText('wait for provider')).toBeTruthy();

    emitAgentEvent({
      sessionId: 'sess-1',
      agentId: 'codex-cli',
      kind: 'message',
      payload: { role: 'user', text: 'wait for provider', turnCorrelationId: 'pending-1' },
      ts: 1,
      source: 'sdk',
    });

    await waitFor(() => expect(screen.queryByText('wait for provider')).toBeNull());
  });

  it('routes Codex busy input through sendAdapterMessage from the main composer', async () => {
    render(<ComposerSdk session={makeSession({ activity: 'working' })} turnBusy canSteerTurn />);

    const input = screen.getByPlaceholderText(/修正当前 Codex CLI 轮次/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'use the latest instruction' } });
    fireEvent.click(screen.getByRole('button', { name: '修正' }));

    await waitFor(() => {
      expect(sendAdapterMessage).toHaveBeenCalledWith('codex-cli', 'sess-1', {
        text: 'use the latest instruction',
      });
    });
  });

  it('routes idle input through sendAdapterMessage', async () => {
    render(<ComposerSdk session={makeSession()} turnBusy={false} canSteerTurn />);

    const input = screen.getByPlaceholderText(/给 Codex CLI 发消息/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'next turn' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => {
      expect(sendAdapterMessage).toHaveBeenCalledWith('codex-cli', 'sess-1', {
        text: 'next turn',
      });
    });
  });

  it('uses Grok insertion copy while keeping negotiated image input available', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...(window.api as object),
        listAdapters: vi.fn().mockResolvedValue([
          {
            id: 'grok-build',
            displayName: 'Grok Build',
            capabilities: { canAcceptAttachments: true },
          },
        ]),
      },
    });

    render(
      <ComposerSdk
        session={makeSession({ agentId: 'grok-build', activity: 'working' })}
        turnBusy
        canSteerTurn
        canSteerTurnAttachments
      />,
    );

    expect(await screen.findByPlaceholderText(/插入当前 Grok Build 轮次/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '插入' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '上传图片' })).toBeTruthy();
  });

  it('restores text into the same composer when busy Codex send fails', async () => {
    sendAdapterMessage.mockRejectedValueOnce(new Error('Codex CLI 当前没有可修正的活动轮次。'));
    render(<ComposerSdk session={makeSession({ activity: 'working' })} turnBusy canSteerTurn />);

    const input = screen.getByPlaceholderText(/修正当前 Codex CLI 轮次/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'do not continue that path' } });
    fireEvent.click(screen.getByRole('button', { name: '修正' }));

    await waitFor(() => {
      expect(input.value).toBe('do not continue that path');
      expect(screen.getByText(/Codex CLI 当前没有可修正的活动轮次/)).toBeTruthy();
    });
  });
});
