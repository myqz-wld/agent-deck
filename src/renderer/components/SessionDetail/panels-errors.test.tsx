// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { AgentDeckMessage, TaskRecord } from '@shared/types';
import { MessagesPanel } from './MessagesPanel';
import { TasksPanel } from './TasksPanel';

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
    labels: ['renderer', 'accessibility'],
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

describe('Session detail list errors', () => {
  it('keeps cached messages visible and hides backend details', async () => {
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
    expect(document.body.textContent).not.toContain('refresh backend detail');

    cleanup();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listAgentDeckMessagesBySession: vi.fn().mockRejectedValue(new Error('initial detail')),
        onAgentDeckMessageChanged: vi.fn(() => vi.fn()),
      },
    });
    render(<MessagesPanel sessionId="from" />);
    expect(await screen.findByText('读取消息失败，请稍后重试。')).toBeTruthy();
    expect(document.body.textContent).not.toContain('initial detail');
  });

  it('keeps cached tasks visible and hides backend details', async () => {
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
    expect(document.body.textContent).not.toContain('task refresh backend detail');

    cleanup();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listSessionTasks: vi.fn().mockRejectedValue(new Error('task initial detail')),
        onTaskChanged: vi.fn(() => vi.fn()),
      },
    });
    render(<TasksPanel sessionId="from" />);
    expect(await screen.findByText('读取任务失败，请稍后重试。')).toBeTruthy();
    expect(document.body.textContent).not.toContain('task initial detail');
  });
});
