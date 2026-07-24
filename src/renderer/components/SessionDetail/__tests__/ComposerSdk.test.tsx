// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentEvent, PendingOutgoingMessage, SessionRecord } from '@shared/types';
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
let listPendingOutgoingMessages: ReturnType<typeof vi.fn>;
let deletePendingOutgoingMessage: ReturnType<typeof vi.fn>;
let emitAgentEvent: (event: AgentEvent) => void;

beforeEach(() => {
  sendAdapterMessage = vi.fn(() => Promise.resolve());
  steerAdapterTurn = vi.fn(() => Promise.resolve());
  interruptAdapterSession = vi.fn(() => Promise.resolve());
  setSessionModelOptions = vi.fn(() => Promise.resolve());
  setAdapterSessionMode = vi.fn(() => Promise.resolve());
  listPendingOutgoingMessages = vi.fn<() => Promise<PendingOutgoingMessage[]>>(
    () => Promise.resolve([]),
  );
  deletePendingOutgoingMessage = vi.fn(() => Promise.resolve(true));
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
      listCodexModelProviders: vi.fn().mockResolvedValue([]),
      sendAdapterMessage,
      steerAdapterTurn,
      interruptAdapterSession,
      setSessionModelOptions,
      setAdapterSessionMode,
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
  vi.restoreAllMocks();
});

describe('ComposerSdk unified input routing', () => {
  it('keeps the expanded editor synchronized and closes it with Escape', async () => {
    render(<ComposerSdk session={makeSession()} />);
    const input = screen.getByPlaceholderText(/给 Codex 发消息/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'inspect this draft' } });
    fireEvent.click(screen.getByRole('button', { name: '放大输入框' }));

    const dialog = screen.getByRole('dialog', { name: '放大消息输入框' });
    const expanded = within(dialog).getByPlaceholderText(/给 Codex 发消息/) as HTMLTextAreaElement;
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
    const expanded = within(dialog).getByPlaceholderText(/给 Codex 发消息/);
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
    fireEvent.change(screen.getByPlaceholderText(/给 Codex 发消息/), {
      target: { value: 'expanded send' },
    });
    fireEvent.click(screen.getByRole('button', { name: '放大输入框' }));
    const dialog = screen.getByRole('dialog', { name: '放大消息输入框' });
    const expanded = within(dialog).getByPlaceholderText(/给 Codex 发消息/);

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
      { id: 'pending-1', text: 'queued request', attachmentCount: 2 },
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
      { id: 'pending-1', text: 'wait for provider', attachmentCount: 0 },
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

  it('offers handoff only after the active turn finishes or is interrupted', () => {
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

    const input = screen.getByPlaceholderText(/修正当前 Codex turn/) as HTMLTextAreaElement;
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

    const input = screen.getByPlaceholderText(/给 Codex 发消息/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'next turn' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => {
      expect(sendAdapterMessage).toHaveBeenCalledWith('codex-cli', 'sess-1', {
        text: 'next turn',
      });
    });
    expect(steerAdapterTurn).not.toHaveBeenCalled();
  });

  it('restores text into the same composer when busy Codex send fails', async () => {
    sendAdapterMessage.mockRejectedValueOnce(new Error('Codex 当前没有可 steer 的 active turn。'));
    render(<ComposerSdk session={makeSession({ activity: 'working' })} turnBusy canSteerTurn />);

    const input = screen.getByPlaceholderText(/修正当前 Codex turn/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'do not continue that path' } });
    fireEvent.click(screen.getByRole('button', { name: '修正' }));

    await waitFor(() => {
      expect(input.value).toBe('do not continue that path');
      expect(screen.getByText(/Codex 当前没有可 steer 的 active turn/)).toBeTruthy();
    });
  });

  it('automatically applies a free-form model and dropdown thinking level to the next turn', async () => {
    render(<ComposerSdk session={makeSession({ model: 'gpt-old', thinking: 'low' })} />);

    fireEvent.click(screen.getByText('Provider、模型与思考程度'));
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

    fireEvent.click(screen.getByText('Provider、模型与思考程度'));
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'gpt-custom' } });

    await waitFor(() => {
      expect(setSessionModelOptions).toHaveBeenCalledWith('codex-cli', 'sess-1', {
        provider: null,
        model: 'gpt-custom',
        thinking: 'low',
      });
    });
  });

  it('shows and persists the Codex provider from the session runtime controls', async () => {
    render(
      <ComposerSdk
        session={makeSession({
          runtimeProvider: 'openai',
          model: 'gpt-old',
          thinking: 'low',
        })}
      />,
    );

    fireEvent.click(screen.getByText('Provider、模型与思考程度'));
    const provider = screen.getByLabelText('Provider') as HTMLInputElement;
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

    fireEvent.click(screen.getByText('Provider、模型与思考程度'));
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

    fireEvent.click(screen.getByText('Provider、模型与思考程度'));
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
    fireEvent.click(await screen.findByLabelText('工作模式'));
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
});
