// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PendingOutgoingMessage, SessionRecord } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import {
  resetImageAttachmentSidecarForTests,
} from '@renderer/hooks/image-attachments/payload-sidecar';
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
      onAgentEvent: vi.fn(() => vi.fn()),
    } as unknown as Window['api'],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ComposerSdk runtime controls and handoff', () => {
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

  it('commits Claude permission and Gateway controls together after capability refresh', async () => {
    type AdapterRows = Awaited<ReturnType<Window['api']['listAdapters']>>;
    let resolveAdapters: (rows: AdapterRows) => void = () => undefined;
    window.api.listAdapters = vi.fn(() => new Promise<AdapterRows>((resolve) => {
      resolveAdapters = resolve;
    }));

    render(<ComposerSdk session={makeSession({
      agentId: 'claude-code',
      title: 'Claude',
      permissionMode: 'bypassPermissions',
      runtimeProvider: 'gateway-a',
      model: 'claude-opus-4-8',
      thinking: 'xhigh',
    })} />);

    expect(screen.queryByLabelText('权限')).toBeNull();
    expect(screen.queryByText('模型网关、模型与思考程度')).toBeNull();

    await act(async () => resolveAdapters([{
      id: 'claude-code',
      displayName: 'Claude Code',
      capabilities: {
        canAcceptAttachments: true,
        canSetPermissionMode: true,
      },
      sessionModes: [],
    }]));

    expect(await screen.findByLabelText('权限')).toBeTruthy();
    fireEvent.click(screen.getByText('模型网关、模型与思考程度'));
    expect((screen.getByLabelText('模型网关') as HTMLInputElement).value).toBe('gateway-a');
    expect((screen.getByLabelText('模型') as HTMLInputElement).value).toBe('claude-opus-4-8');
  });

  it('shows Claude runtime configuration progress only after the shared 150 ms grace', () => {
    vi.useFakeTimers();
    type AdapterRows = Awaited<ReturnType<Window['api']['listAdapters']>>;
    window.api.listAdapters = vi.fn(() => new Promise<AdapterRows>(() => undefined));

    render(<ComposerSdk session={makeSession({
      agentId: 'claude-code',
      title: 'Claude',
      permissionMode: 'bypassPermissions',
      runtimeProvider: 'gateway-a',
    })} />);

    expect(screen.queryByText('正在读取会话运行配置…')).toBeNull();
    act(() => vi.advanceTimersByTime(149));
    expect(screen.queryByText('正在读取会话运行配置…')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText('正在读取会话运行配置…')).toBeTruthy();
    expect(screen.queryByLabelText('权限')).toBeNull();
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
    window.api.listCodexGatewayProfiles = vi.fn().mockResolvedValue([
      { id: 'openai' },
      { id: 'openai-custom' },
    ]);
    render(
      <ComposerSdk
        session={makeSession({
          activity: 'working',
          runtimeProvider: 'openai',
          model: 'gpt-old',
          thinking: 'low',
        })}
      />,
    );

    fireEvent.click(screen.getByText('模型网关、模型与思考程度'));
    const provider = screen.getByLabelText('模型网关') as HTMLInputElement;
    expect(provider.value).toBe('openai');
    expect(provider.readOnly).toBe(true);
    expect((screen.getByLabelText('模型') as HTMLInputElement).value).toBe('gpt-old');
    fireEvent.focus(provider);
    fireEvent.click(await screen.findByRole('option', { name: 'openai-custom' }));

    await waitFor(() => {
      expect(setSessionModelOptions).toHaveBeenCalledWith('codex-cli', 'sess-1', {
        provider: 'openai-custom',
        model: 'gpt-old',
        thinking: 'low',
      });
    });
  });

  it('shows a concise runtime error and restores the last saved Gateway', async () => {
    window.api.listCodexGatewayProfiles = vi.fn().mockResolvedValue([
      { id: 'openai' },
      { id: 'next-gateway' },
    ]);
    setSessionModelOptions.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'adapter:set-session-model-options': " +
        'Error: 所选模型网关已不可用，请刷新列表后重试。',
    ));
    render(<ComposerSdk session={makeSession({
      activity: 'working',
      runtimeProvider: 'openai',
      model: 'gpt-old',
      thinking: 'low',
    })} />);

    fireEvent.click(screen.getByText('模型网关、模型与思考程度'));
    const provider = screen.getByLabelText('模型网关') as HTMLInputElement;
    fireEvent.focus(provider);
    fireEvent.click(await screen.findByRole('option', { name: 'next-gateway' }));

    await waitFor(() => {
      expect(screen.getByText(
        '运行设置失败：所选模型网关已不可用，请刷新列表后重试。',
      )).toBeTruthy();
      expect(provider.value).toBe('openai');
    });
    expect(document.body.textContent).not.toContain('Error invoking remote method');
    expect(document.body.textContent).not.toContain('profile');
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
