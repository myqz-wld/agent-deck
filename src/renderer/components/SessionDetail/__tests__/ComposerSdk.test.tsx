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

  it('applies a free-form model and dropdown thinking level to the next turn', async () => {
    render(<ComposerSdk session={makeSession({ model: 'gpt-old', thinking: 'low' })} />);

    fireEvent.click(screen.getByText('模型与思考程度'));
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'gpt-custom' } });
    fireEvent.click(screen.getByLabelText('思考程度'));
    fireEvent.click(screen.getByRole('option', { name: 'ULTRA' }));
    fireEvent.click(screen.getByRole('button', { name: '应用到下一轮' }));

    await waitFor(() => {
      expect(setSessionModelOptions).toHaveBeenCalledWith('codex-cli', 'sess-1', {
        model: 'gpt-custom',
        thinking: 'ultra',
      });
    });
  });
});
