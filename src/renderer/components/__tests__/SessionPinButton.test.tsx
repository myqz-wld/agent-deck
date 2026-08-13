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
let archiveSession: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setSessionPinned = vi.fn().mockResolvedValue(makeSession({ pinnedAt: 1 }));
  archiveSession = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { archiveSession, setSessionPinned },
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

  it('实时卡片在鼠标右键位置打开统一操作菜单', async () => {
    const view = render(
      <SessionCard session={makeSession()} selected={false} onSelect={vi.fn()} />,
    );
    fireEvent.contextMenu(view.container.querySelector('[data-session-card-frame="true"]')!, {
      clientX: 180,
      clientY: 120,
    });
    const menu = screen.getByRole('menu', { name: '会话操作' });
    expect(menu.style.left).toBe('180px');
    expect(menu.style.top).toBe('120px');
    fireEvent.click(screen.getByRole('menuitem', { name: '归档' }));
    expect(archiveSession).toHaveBeenCalledWith('session-1');
  });

  it('为统一右键菜单保留键盘入口', () => {
    const view = render(
      <SessionCard session={makeSession()} selected={false} onSelect={vi.fn()} />,
    );
    const card = view.container.querySelector('[data-session-card-frame="true"]')!;
    fireEvent.keyDown(card, { key: 'F10', shiftKey: true });
    expect(screen.getByRole('menu', { name: '会话操作' })).toBeTruthy();
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
