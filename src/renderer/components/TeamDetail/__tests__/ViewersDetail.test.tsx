// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { AgentDeckMessage, AgentEvent, TaskRecord } from '@shared/types';
import { EventsSection } from '../EventsSection';
import { TasksSection } from '../TasksSection';
import { MessagesSection } from '../MessagesSection';
import { MessagesPanel } from '../../SessionDetail/MessagesPanel';
import { TasksPanel } from '../../SessionDetail/TasksPanel';

vi.mock('@renderer/stores/session-store', () => ({
  useSessionStore: (selector: (state: unknown) => unknown) => selector({
    sessions: new Map([
      ['from', { title: 'Claude Code reviewer' }],
      ['to', { title: 'Codex CLI lead' }],
    ]),
  }),
}));

vi.mock('@renderer/components/MarkdownText', () => ({
  MarkdownText: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div>,
}));

afterEach(() => cleanup());

function event(
  id: number,
  kind: AgentEvent['kind'],
  payload: unknown,
): AgentEvent & { id: number } {
  return {
    id,
    sessionId: 'from',
    agentId: 'claude-code',
    kind,
    payload,
    ts: 1,
  };
}

function task(): TaskRecord {
  return {
    id: 'task-1',
    ownerSessionId: 'from',
    teamId: 'team-1',
    subject: '修复详情查看器',
    description: '完整说明第一行\n完整说明第二行',
    status: 'active',
    activeForm: '正在验证焦点行为',
    priority: 3,
    blocks: [],
    blockedBy: [],
    labels: ['renderer', 'accessibility', 'regression', 'fourth-label'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

function message(body: string): AgentDeckMessage {
  return {
    id: 'message-1',
    teamId: 'team-1',
    fromSessionId: 'from',
    toSessionId: 'to',
    body,
    status: 'delivered',
    statusReason: null,
    sentAt: 1,
    deliveredAt: 2,
    attemptCount: 1,
    lastAttemptAt: 1,
    deliveringSince: null,
    replyToMessageId: null,
    deliveryGeneration: 1,
    deliveryLeaseToSessionId: null,
  };
}

describe('TeamDetail original compact presentation', () => {
  it('keeps event summaries truncated inline without adding a detail viewer', () => {
    const longText = `${'摘要'.repeat(50)}完整事件结尾`;
    render(<EventsSection events={[event(1, 'message', { text: longText, role: 'assistant' })]} />);
    expect(document.body.textContent).not.toContain('完整事件结尾');
    expect(screen.queryByRole('button', { name: /展开.*详情/ })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps task rows compact with the original title and active form', () => {
    const { container } = render(<TasksSection tasks={[task()]} />);
    expect(screen.getByText('修复详情查看器')).toBeTruthy();
    expect(screen.getByText(/正在验证焦点行为/)).toBeTruthy();
    expect(container.querySelector('li[title]')?.getAttribute('title'))
      .toBe('完整说明第一行\n完整说明第二行');
    expect(screen.queryByRole('button', { name: /展开任务详情/ })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders complete team messages inline without a magnify entry', () => {
    const body = `${'x'.repeat(700)}完整消息结尾`;
    render(<MessagesSection messages={[message(body)]} />);
    expect(screen.getByTestId('markdown').textContent).toContain('完整消息结尾');
    expect(screen.queryByRole('button', { name: '展开完整消息' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Session detail list errors', () => {
  it('keeps cached messages visible with fixed refresh copy and gives initial failures retry advice', async () => {
    let onMessageChanged: (() => void) | undefined;
    const listMessages = vi.fn()
      .mockResolvedValueOnce([message('缓存消息')])
      .mockRejectedValueOnce(new Error('refresh backend detail'));
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listAgentDeckMessagesBySession: listMessages,
        onAgentDeckMessageChanged: vi.fn((callback: () => void) => {
          onMessageChanged = callback;
          return vi.fn();
        }),
      },
    });

    render(<MessagesPanel sessionId="from" />);
    expect(await screen.findByText('缓存消息')).toBeTruthy();
    onMessageChanged?.();
    await waitFor(() => expect(listMessages).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('刷新失败，当前显示上次结果。')).toBeTruthy();
    expect(screen.getByText('缓存消息')).toBeTruthy();
    expect(document.body.textContent).not.toContain('refresh backend detail');

    cleanup();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listAgentDeckMessagesBySession: vi.fn()
          .mockRejectedValue(new Error('initial backend detail')),
        onAgentDeckMessageChanged: vi.fn(() => vi.fn()),
      },
    });
    render(<MessagesPanel sessionId="from" />);
    expect(await screen.findByText('读取消息失败，请稍后重试。')).toBeTruthy();
    expect(document.body.textContent).not.toContain('initial backend detail');
  });

  it('keeps cached tasks visible and never exposes loader details', async () => {
    let onTaskChanged: (() => void) | undefined;
    const listTasks = vi.fn()
      .mockResolvedValueOnce({ tasks: [task()] })
      .mockRejectedValueOnce(new Error('task refresh backend detail'));
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listSessionTasks: listTasks,
        onTaskChanged: vi.fn((callback: () => void) => {
          onTaskChanged = callback;
          return vi.fn();
        }),
      },
    });

    render(<TasksPanel sessionId="from" />);
    expect(await screen.findByText('修复详情查看器')).toBeTruthy();
    onTaskChanged?.();
    await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('刷新失败，当前显示上次结果。')).toBeTruthy();
    expect(screen.getByText('修复详情查看器')).toBeTruthy();
    expect(document.body.textContent).not.toContain('task refresh backend detail');

    cleanup();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listSessionTasks: vi.fn().mockRejectedValue(new Error('task initial backend detail')),
        onTaskChanged: vi.fn(() => vi.fn()),
      },
    });
    render(<TasksPanel sessionId="from" />);
    expect(await screen.findByText('读取任务失败，请稍后重试。')).toBeTruthy();
    expect(document.body.textContent).not.toContain('task initial backend detail');
  });
});
