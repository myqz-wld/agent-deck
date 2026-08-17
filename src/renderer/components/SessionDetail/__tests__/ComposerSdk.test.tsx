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
let steerAdapterTurn: ReturnType<typeof vi.fn>;
let interruptAdapterSession: ReturnType<typeof vi.fn>;
let setSessionModelOptions: ReturnType<typeof vi.fn>;
let setAdapterSessionMode: ReturnType<typeof vi.fn>;
let setAdapterPermissionMode: ReturnType<typeof vi.fn>;
let listPendingOutgoingMessages: ReturnType<typeof vi.fn>;
let deletePendingOutgoingMessage: ReturnType<typeof vi.fn>;
let loadPendingOutgoingAttachment: ReturnType<typeof vi.fn>;
let emitAgentEvent: (event: AgentEvent) => void;

beforeEach(() => {
  sendAdapterMessage = vi.fn(() => Promise.resolve());
  steerAdapterTurn = vi.fn(() => Promise.resolve());
  interruptAdapterSession = vi.fn(() => Promise.resolve());
  setSessionModelOptions = vi.fn(() => Promise.resolve());
  setAdapterSessionMode = vi.fn(() => Promise.resolve());
  setAdapterPermissionMode = vi.fn(() => Promise.resolve());
  listPendingOutgoingMessages = vi.fn<() => Promise<PendingOutgoingMessage[]>>(
    () => Promise.resolve([]),
  );
  deletePendingOutgoingMessage = vi.fn(() => Promise.resolve(true));
  loadPendingOutgoingAttachment = vi.fn(() => Promise.resolve({
    ok: false,
    reason: 'not_found',
  }));
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
      steerAdapterTurn,
      interruptAdapterSession,
      setSessionModelOptions,
      setAdapterSessionMode,
      setAdapterPermissionMode,
      listPendingOutgoingMessages,
      deletePendingOutgoingMessage,
      loadPendingOutgoingAttachment,
      onAgentEvent: vi.fn((listener: (event: AgentEvent) => void) => {
        emitAgentEvent = listener;
        return vi.fn();
      }),
    } as unknown as Window['api'],
  });
});

afterEach(() => {
  cleanup();
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

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', {
      name: '放大消息输入框',
    })).toBeNull());
    expect(input.value).toBe('edited in expanded view');
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

  it('offers handoff only after the active round finishes or is interrupted', () => {
    const onHandOff = vi.fn();
    const view = render(
      <ComposerSdk
        session={makeSession({ activity: 'working' })}
        turnBusy
        canSteerTurn
        onHandOff={onHandOff}
      />,
    );
    const busyButton = screen.getByRole('button', { name: '接力' }) as HTMLButtonElement;
    expect(busyButton.disabled).toBe(true);
    expect(busyButton.title).toBe('当前任务完成或中断后可接力');
    fireEvent.click(busyButton);
    expect(onHandOff).not.toHaveBeenCalled();

    view.rerender(
      <ComposerSdk
        session={makeSession({ activity: 'waiting' })}
        turnBusy={false}
        onHandOff={onHandOff}
      />,
    );
    expect(
      (screen.getByRole('button', { name: '接力' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    view.rerender(
      <ComposerSdk session={makeSession()} turnBusy={false} onHandOff={onHandOff} />,
    );
    const idleButton = screen.getByRole('button', { name: '接力' }) as HTMLButtonElement;
    expect(idleButton.disabled).toBe(false);
    fireEvent.click(idleButton);
    expect(onHandOff).toHaveBeenCalledOnce();
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
    expect(steerAdapterTurn).not.toHaveBeenCalled();
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
    expect(steerAdapterTurn).not.toHaveBeenCalled();
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

  it('automatically applies a free-form model and dropdown thinking level to the next round', async () => {
    render(<ComposerSdk session={makeSession({ model: 'gpt-old', thinking: 'low' })} />);

    fireEvent.click(screen.getByText('模型网关、模型与思考程度'));
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'gpt-custom' } });
    fireEvent.click(screen.getByLabelText('思考程度'));
    fireEvent.click(screen.getByRole('option', { name: 'ULTRA' }));

    await waitFor(() => {
      expect(setSessionModelOptions).toHaveBeenCalledWith('codex-cli', 'sess-1', {
        provider: null,
        model: 'gpt-custom',
        thinking: 'ultra',
      });
    });
    expect(screen.queryByRole('button', { name: '应用到下一轮' })).toBeNull();
  });

  it('automatically persists a free-form model without another control change', async () => {
    render(<ComposerSdk session={makeSession({ model: 'gpt-old', thinking: 'low' })} />);

    fireEvent.click(screen.getByText('模型网关、模型与思考程度'));
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'gpt-custom' } });

    await waitFor(() => {
      expect(setSessionModelOptions).toHaveBeenCalledWith('codex-cli', 'sess-1', {
        provider: null,
        model: 'gpt-custom',
        thinking: 'low',
      });
    });
  });

  it('shows and persists the Codex Gateway from the session runtime controls', async () => {
    render(
      <ComposerSdk
        session={makeSession({
          runtimeProvider: 'openai',
          model: 'gpt-old',
          thinking: 'low',
        })}
      />,
    );

    fireEvent.click(screen.getByText('模型网关、模型与思考程度'));
    const provider = screen.getByLabelText('模型网关') as HTMLInputElement;
    expect(provider.value).toBe('openai');
    expect((screen.getByLabelText('模型') as HTMLInputElement).value).toBe('gpt-old');
    fireEvent.change(provider, { target: { value: 'openai-custom' } });

    await waitFor(() => {
      expect(setSessionModelOptions).toHaveBeenCalledWith('codex-cli', 'sess-1', {
        provider: 'openai-custom',
        model: null,
        thinking: 'low',
      });
    });
  });

  it('sends the latest rapid edit after an older selection settles', async () => {
    let rejectFirst: (error: Error) => void = () => undefined;
    setSessionModelOptions
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce(undefined);
    render(<ComposerSdk session={makeSession({ model: 'gpt-old', thinking: 'low' })} />);

    fireEvent.click(screen.getByText('模型网关、模型与思考程度'));
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'first-model' } });
    fireEvent.click(screen.getByLabelText('思考程度'));
    fireEvent.click(screen.getByRole('option', { name: 'HIGH' }));
    await waitFor(() => {
      expect(setSessionModelOptions).toHaveBeenCalledWith('codex-cli', 'sess-1', {
        provider: null,
        model: 'first-model',
        thinking: 'high',
      });
    });

    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'latest-model' } });
    fireEvent.click(screen.getByLabelText('思考程度'));
    fireEvent.click(screen.getByRole('option', { name: 'ULTRA' }));
    expect(setSessionModelOptions).toHaveBeenCalledTimes(1);

    rejectFirst(new Error('first selection failed'));
    await waitFor(() => {
      expect(setSessionModelOptions).toHaveBeenLastCalledWith('codex-cli', 'sess-1', {
        provider: null,
        model: 'latest-model',
        thinking: 'ultra',
      });
      expect((screen.getByLabelText('模型') as HTMLInputElement).value).toBe('latest-model');
      expect(screen.queryByText('first selection failed')).toBeNull();
    });
  });

  it('keeps a new session draft when an older session write finishes later', async () => {
    let rejectFirst: (error: Error) => void = () => undefined;
    setSessionModelOptions
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const view = render(<ComposerSdk session={makeSession({ model: 'gpt-old', thinking: 'low' })} />);

    fireEvent.click(screen.getByText('模型网关、模型与思考程度'));
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'old-session-model' } });
    fireEvent.click(screen.getByLabelText('思考程度'));
    fireEvent.click(screen.getByRole('option', { name: 'HIGH' }));
    await waitFor(() => {
      expect(setSessionModelOptions).toHaveBeenCalledWith('codex-cli', 'sess-1', {
        provider: null,
        model: 'old-session-model',
        thinking: 'high',
      });
    });

    view.rerender(<ComposerSdk session={makeSession({ id: 'sess-2', model: 'gpt-new', thinking: 'low' })} />);
    await waitFor(() => {
      expect((screen.getByLabelText('模型') as HTMLInputElement).value).toBe('gpt-new');
    });
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'new-session-model' } });
    fireEvent.click(screen.getByLabelText('思考程度'));
    fireEvent.click(screen.getByRole('option', { name: 'ULTRA' }));
    await waitFor(() => {
      expect(setSessionModelOptions).toHaveBeenCalledWith('codex-cli', 'sess-2', {
        provider: null,
        model: 'new-session-model',
        thinking: 'ultra',
      });
    });

    rejectFirst(new Error('old session failed'));
    await waitFor(() => {
      expect((screen.getByLabelText('模型') as HTMLInputElement).value).toBe('new-session-model');
      expect(screen.queryByText('old session failed')).toBeNull();
    });
  });

  it('shows Grok work modes from the adapter profile and applies a change', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...(window.api as object),
        listAdapters: vi.fn().mockResolvedValue([
          {
            id: 'grok-build',
            displayName: 'Grok Build',
            capabilities: {
              canAcceptAttachments: false,
              canSetSessionMode: true,
              canSetPermissionMode: false,
            },
            sessionModes: ['default', 'plan', 'ask'],
          },
        ]),
        setAdapterSessionMode,
      },
    });

    render(
      <ComposerSdk
        session={makeSession({
          agentId: 'grok-build',
          title: 'Grok',
          sessionMode: 'default',
        })}
      />,
    );
    fireEvent.click(await screen.findByLabelText('模式'));
    fireEvent.click(screen.getByRole('option', { name: '问答模式' }));

    await waitFor(() => {
      expect(setAdapterSessionMode).toHaveBeenCalledWith(
        'grok-build',
        'sess-1',
        'ask',
      );
    });
    expect(screen.queryByText('权限')).toBeNull();
  });

  it('shows provider-restored dontAsk exactly but keeps it read-only', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...(window.api as object),
        listAdapters: vi.fn().mockResolvedValue([
          {
            id: 'claude-code',
            displayName: 'Claude Code',
            capabilities: {
              canAcceptAttachments: true,
              canSetPermissionMode: true,
            },
          },
        ]),
      },
    });

    render(
      <ComposerSdk
        session={makeSession({
          agentId: 'claude-code',
          title: 'Claude',
          permissionMode: 'dontAsk',
        })}
      />,
    );

    const permission = await screen.findByLabelText('权限');
    expect(permission.textContent).toContain('当前状态：不询问（只读）');
    fireEvent.click(permission);
    const restored = screen.getByRole('option', {
      name: '当前状态：不询问（只读）',
    }) as HTMLButtonElement;
    expect(restored.disabled).toBe(true);
    expect(screen.getAllByRole('option')).toHaveLength(6);
    expect(setAdapterPermissionMode).not.toHaveBeenCalled();
  });
});
