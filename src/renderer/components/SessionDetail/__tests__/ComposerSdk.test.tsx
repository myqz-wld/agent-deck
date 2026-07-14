// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SessionRecord } from '@shared/types';
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

beforeEach(() => {
  sendAdapterMessage = vi.fn(() => Promise.resolve());
  steerAdapterTurn = vi.fn(() => Promise.resolve());
  interruptAdapterSession = vi.fn(() => Promise.resolve());
  setSessionModelOptions = vi.fn(() => Promise.resolve());
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      sendAdapterMessage,
      steerAdapterTurn,
      interruptAdapterSession,
      setSessionModelOptions,
    } as unknown as Window['api'],
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ComposerSdk unified input routing', () => {
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

    fireEvent.click(screen.getByText('模型与思考程度'));
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'gpt-custom' } });
    fireEvent.click(screen.getByLabelText('思考程度'));
    fireEvent.click(screen.getByRole('option', { name: 'ULTRA' }));

    await waitFor(() => {
      expect(setSessionModelOptions).toHaveBeenCalledWith('codex-cli', 'sess-1', {
        model: 'gpt-custom',
        thinking: 'ultra',
      });
    });
    expect(screen.queryByRole('button', { name: '应用到下一轮' })).toBeNull();
  });

  it('automatically persists a free-form model without another control change', async () => {
    render(<ComposerSdk session={makeSession({ model: 'gpt-old', thinking: 'low' })} />);

    fireEvent.click(screen.getByText('模型与思考程度'));
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'gpt-custom' } });

    await waitFor(() => {
      expect(setSessionModelOptions).toHaveBeenCalledWith('codex-cli', 'sess-1', {
        model: 'gpt-custom',
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

    fireEvent.click(screen.getByText('模型与思考程度'));
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'first-model' } });
    fireEvent.click(screen.getByLabelText('思考程度'));
    fireEvent.click(screen.getByRole('option', { name: 'HIGH' }));
    await waitFor(() => {
      expect(setSessionModelOptions).toHaveBeenCalledWith('codex-cli', 'sess-1', {
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

    fireEvent.click(screen.getByText('模型与思考程度'));
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'old-session-model' } });
    fireEvent.click(screen.getByLabelText('思考程度'));
    fireEvent.click(screen.getByRole('option', { name: 'HIGH' }));
    await waitFor(() => {
      expect(setSessionModelOptions).toHaveBeenCalledWith('codex-cli', 'sess-1', {
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
});
