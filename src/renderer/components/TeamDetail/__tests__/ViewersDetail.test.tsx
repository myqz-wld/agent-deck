// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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

vi.mock('@renderer/components/diff/DiffViewer', () => ({
  DiffViewer: ({ payload }: { payload: unknown }) => (
    <div data-testid="team-diff-viewer">{JSON.stringify(payload)}</div>
  ),
}));

vi.mock('@renderer/components/MarkdownText', () => ({
  MarkdownText: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div>,
}));

vi.mock('@renderer/components/UploadedImageThumb', () => ({
  UploadedImageThumb: ({ alt }: { alt: string }) => <img alt={alt} />,
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
  };
}

describe('TeamDetail viewers', () => {
  it('exposes the complete event instead of permanently truncating its 80-character summary', () => {
    const longText = `${'摘要'.repeat(50)}完整事件结尾`;
    render(<EventsSection events={[event(1, 'message', { text: longText, role: 'assistant' })]} />);
    expect(document.body.textContent).not.toContain('完整事件结尾');
    fireEvent.click(screen.getByRole('button', { name: '展开消息详情' }));
    expect(screen.getByRole('dialog', { name: '消息详情' }).textContent)
      .toContain('完整事件结尾');
  });

  it('preserves typed image diff data and mounts the heavy viewer only when selected', () => {
    render(
      <EventsSection
        events={[event(2, 'file-changed', {
          kind: 'image',
          filePath: '/repo/image.png',
          before: { kind: 'snapshot', snapshotId: 'before-1' },
          after: { kind: 'path', path: '/repo/image.png' },
          metadata: {
            annotations: [{ id: 'a-1', text: '注意边缘', status: 'open' }],
          },
        })]}
      />,
    );
    expect(screen.queryByTestId('team-diff-viewer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开文件改动详情' }));
    const viewer = screen.getByTestId('team-diff-viewer');
    expect(viewer.textContent).toContain('"kind":"image"');
    expect(viewer.textContent).toContain('"snapshotId":"before-1"');
    expect(viewer.textContent).toContain('"path":"/repo/image.png"');
    expect(viewer.closest('[data-expandable-heavy-view]')?.getAttribute(
      'data-expandable-heavy-view',
    )).toBe('image-diff');
  });

  it('shows subject, description, active form, and every task label accessibly', () => {
    render(<TasksSection tasks={[task()]} />);
    fireEvent.click(screen.getByRole('button', { name: '展开任务详情：修复详情查看器' }));
    const dialog = screen.getByRole('dialog', { name: '任务详情' });
    expect(dialog.textContent).toContain('完整说明第二行');
    expect(dialog.textContent).toContain('正在验证焦点行为');
    const labels = within(dialog).getByRole('list', { name: '任务全部标签' });
    expect(within(labels).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'renderer',
      'accessibility',
      'regression',
      'fourth-label',
    ]);
  });

  it('adds one viewer only above the message capacity threshold', () => {
    const body = `${'x'.repeat(700)}完整消息结尾`;
    render(<MessagesSection messages={[message(body)]} />);
    expect(screen.getByRole('button', { name: '展开完整消息' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '展开完整消息' }));
    expect(screen.getByRole('dialog', { name: '跨会话消息详情' }).textContent)
      .toContain('完整消息结尾');
    cleanup();
    render(<MessagesSection messages={[message('短消息')]} />);
    expect(screen.queryByRole('button', { name: '展开完整消息' })).toBeNull();
  });

  it('shows the complete structured payload for waiting events', () => {
    render(
      <EventsSection
        events={[event(3, 'waiting-for-user', {
          type: 'custom-approval',
          subject: '批准发布',
          choices: ['允许', '拒绝'],
          nested: { retained: '完整结构字段' },
        })]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '展开等待响应详情' }));
    const dialog = screen.getByRole('dialog', { name: '等待响应详情' });
    expect(dialog.textContent).toContain('"subject": "批准发布"');
    expect(dialog.textContent).toContain('"retained": "完整结构字段"');
    expect(dialog.textContent).not.toContain('无更多详情');
  });

  it('normalizes Team message events with Activity error, wire, hand-off, and attachment semantics', () => {
    render(
      <EventsSection
        events={[event(4, 'message', {
          role: 'user',
          error: true,
          text: [
            '[from Reviewer @ claude-code][msg message-4][sid source-session]',
            '## Hand-off context (auto-injected by Agent Deck MCP)',
            '- source context',
            '',
            '---',
            '',
            '# Plain error body',
          ].join('\n'),
          handOff: {
            mode: 'session',
            fromCallerSid: 'caller-session',
            sourceMaxEventId: 42,
          },
          attachments: [{
            kind: 'uploaded',
            path: '/uploads/team.png',
            mime: 'image/png',
            bytes: 12,
          }],
        })]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '展开消息详情' }));
    const dialog = screen.getByRole('dialog', { name: '消息详情' });
    expect(dialog.textContent).toContain('# Plain error body');
    expect(dialog.textContent).toContain('Reviewer · Claude Code');
    expect(dialog.textContent).toContain('查看接力上下文');
    expect(within(dialog).getByRole('img', { name: '附件图片 1' })).toBeTruthy();
    expect(within(dialog).queryByTestId('markdown')).toBeNull();
    expect(dialog.textContent).not.toContain('[from Reviewer');
  });

  it('keeps Team tool reason, duration, and truncation details', () => {
    render(
      <EventsSection
        events={[event(5, 'tool-use-end', {
          toolName: 'RemoteCheck',
          toolInput: { target: 'service' },
          status: 'failed',
          toolResult: '远端检查结果',
          reason: '连接被远端拒绝',
          durationMs: 1500,
          toolResultTruncated: true,
        })]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '展开工具完成详情' }));
    const dialog = screen.getByRole('dialog', { name: '工具完成详情' });
    expect(dialog.textContent).toContain('远端检查结果');
    expect(dialog.textContent).toContain('连接被远端拒绝');
    expect(dialog.textContent).toContain('1.5s');
    expect(dialog.textContent).toContain('结果已截断');
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
