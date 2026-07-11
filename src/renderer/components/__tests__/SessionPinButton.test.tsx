// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SessionRecord } from '@shared/types';
import { SessionCard } from '../SessionCard';
import { SessionPinButton } from '../SessionPinButton';

vi.mock('@renderer/utils/logger', () => ({
  default: { scope: () => ({ warn: vi.fn() }) },
}));

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-1',
    agentId: 'claude-code',
    cwd: '/test',
    title: 'Test Session',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 0,
    lastEventAt: 0,
    endedAt: null,
    archivedAt: null,
    pinnedAt: null,
    ...overrides,
  } as SessionRecord;
}

let setSessionPinned: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setSessionPinned = vi.fn().mockResolvedValue(makeSession({ pinnedAt: 1 }));
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { setSessionPinned },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('SessionPinButton', () => {
  it('使用 zh-CN 标签并按当前实时记录请求置顶/取消置顶', async () => {
    const view = render(<SessionPinButton session={makeSession()} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '置顶会话' })));
    expect(setSessionPinned).toHaveBeenCalledWith('session-1', true);

    view.rerender(<SessionPinButton session={makeSession({ pinnedAt: 123 })} />);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: '取消置顶会话' })),
    );
    expect(setSessionPinned).toHaveBeenLastCalledWith('session-1', false);
  });

  it('在 SessionCard 中点击置顶不会触发选卡', async () => {
    const onSelect = vi.fn();
    render(
      <SessionCard
        session={makeSession()}
        selected={false}
        onSelect={onSelect}
      />,
    );

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '置顶会话' })));

    expect(setSessionPinned).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('请求未完成时同步去重，且失败后保持服务端记录状态并恢复可点击', async () => {
    let rejectRequest!: (error: Error) => void;
    setSessionPinned.mockImplementationOnce(
      () =>
        new Promise<SessionRecord>((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );
    render(<SessionPinButton session={makeSession()} />);
    const button = screen.getByRole('button', { name: '置顶会话' }) as HTMLButtonElement;

    fireEvent.click(button);
    fireEvent.click(button);

    expect(setSessionPinned).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(
      screen.getByRole('button', { name: '置顶会话' }).getAttribute('aria-pressed'),
    ).toBe('false');

    await act(async () => rejectRequest(new Error('write failed')));

    const readyButton = screen.getByRole('button', { name: '置顶会话' }) as HTMLButtonElement;
    expect(readyButton.disabled).toBe(false);
    expect(readyButton.getAttribute('aria-pressed')).toBe('false');
  });
});
