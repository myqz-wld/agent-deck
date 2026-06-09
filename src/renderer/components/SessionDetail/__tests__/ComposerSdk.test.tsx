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

beforeEach(() => {
  sendAdapterMessage = vi.fn(() => Promise.resolve());
  steerAdapterTurn = vi.fn(() => Promise.resolve());
  interruptAdapterSession = vi.fn(() => Promise.resolve());
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      sendAdapterMessage,
      steerAdapterTurn,
      interruptAdapterSession,
    } as unknown as Window['api'],
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ComposerSdk unified input routing', () => {
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
});
