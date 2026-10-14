// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import type { AgentEvent } from '@shared/types';
import { MessageBubble } from './message-row';
import { normalizeAgentMessage } from '../viewers/message-content';

vi.mock('@renderer/components/MarkdownText', () => ({
  MarkdownText: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div>,
}));
vi.mock('@renderer/components/UploadedImageThumb', () => ({
  UploadedImageThumb: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
vi.mock('@renderer/components/ImageLightbox', () => ({
  ImageLightbox: () => <div role="dialog" aria-label="图片预览" />,
}));

afterEach(() => cleanup());

describe('MessageBubble original inline presentation', () => {
  it('keeps render mode, attachments, and wire metadata in the message row', () => {
    const event: AgentEvent = {
      sessionId: 'session-1',
      agentId: 'codex-cli',
      kind: 'message',
      payload: {
        role: 'user',
        text: '[from Reviewer @ claude-code][msg message-1][sid source-1]\n# Full message',
        attachments: [{
          kind: 'uploaded',
          path: '/uploads/image.png',
          mime: 'image/png',
          bytes: 42,
        }],
      },
      ts: 1,
    };
    render(<MessageBubble event={event} agentId="codex-cli" />);

    expect(document.body.textContent).toContain('Reviewer');
    expect(screen.getByRole('img', { name: '附件图片 1' })).toBeTruthy();
    expect(screen.queryByTestId('markdown')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'TXT' }));
    expect(screen.getByTestId('markdown').textContent).toBe('# Full message');
    expect(screen.queryByRole('button', { name: '展开消息详情' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('uses the original inline disclosure for long messages', () => {
    const text = `${'消息'.repeat(401)}完整结尾`;
    const event: AgentEvent = {
      sessionId: 'session-1',
      agentId: 'codex-cli',
      kind: 'message',
      payload: { role: 'assistant', text },
      ts: 7,
    };
    const { container } = render(<MessageBubble event={event} agentId="codex-cli" />);

    const trigger = screen.getByRole('button', { name: `展开（${text.length} 字）` });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.max-h-72')).toBeTruthy();
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: '收起' }).getAttribute('aria-expanded'))
      .toBe('true');
    expect(container.querySelector('.max-h-72')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders worktree transition status as a compact system row', () => {
    const event: AgentEvent = {
      sessionId: 'session-1',
      agentId: 'codex-cli',
      kind: 'message',
      payload: {
        role: 'system',
        text: '已切换到 worktree，继续当前任务',
        worktreeTransitionStatus: { generation: 2 },
      },
      ts: 11,
    };
    const normalized = normalizeAgentMessage(event);
    expect(normalized).toMatchObject({
      role: 'system',
      isSystem: true,
      isUser: false,
    });
    expect(normalized.role).toBe('system');

    render(<MessageBubble event={event} agentId="codex-cli" />);

    expect(screen.getByText('系统')).toBeTruthy();
    expect(
      screen.getByText('已切换到 worktree，继续当前任务'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'TXT' })).toBeNull();
    expect(document.querySelector('li')?.className).toContain('justify-center');
  });

  it.each([
    ['codex-cli', 'Codex'], ['claude-code', 'Claude'], ['grok-build', 'Grok Build'],
  ])('renders %s command feedback as a status strip', (agentId, provider) => {
    const event: AgentEvent = {
      sessionId: 'session-1',
      agentId,
      kind: 'message',
      payload: {
        role: 'system',
        text: `${provider} /clear 已完成，已开始新对话，原时间线保留`,
        sessionCommandStatus: { command: 'clear', status: 'completed' },
      },
      ts: 12,
    };

    render(<MessageBubble event={event} agentId={agentId} />);

    expect(screen.queryByText('系统')).toBeNull();
    expect(screen.getByText(`${provider} /clear 已完成，已开始新对话，原时间线保留`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'TXT' })).toBeNull();
    expect(document.querySelector('li')?.className).not.toContain('justify-center');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps long command failures available in a collapsed status detail', () => {
    const text = 'Codex /clear 失败：服务未响应\n保留完整诊断信息';
    const event: AgentEvent = { sessionId: 'session-1', agentId: 'codex-cli', kind: 'message', ts: 12,
      payload: { role: 'system', text, error: true,
        sessionCommandStatus: { command: 'clear', status: 'failed' } } };
    render(<MessageBubble event={event} agentId="codex-cli" />);
    const trigger = screen.getByRole('button', { name: 'Codex /clear 失败，展开详情' });
    const detail = document.getElementById(trigger.getAttribute('aria-controls')!)!;
    expect(detail.hidden).toBe(true);
    expect(document.querySelector('li')?.className).toContain('border-status-error');
    fireEvent.click(trigger);
    expect(detail.hidden).toBe(false);
    expect(detail.textContent).toBe(text);
  });

  it.each([
    { role: 'system' },
    { role: 'system', sessionCommandStatus: { command: 'clear' } },
    { role: 'user', sessionCommandStatus: { command: 'clear', status: 'completed' } },
    { role: 'assistant', sessionCommandStatus: { command: 'clear', status: 'completed' } },
  ])('does not classify ordinary conversation text as a command: %j', (payload) => {
    const event: AgentEvent = { sessionId: 'session-1', agentId: 'codex-cli', kind: 'message', ts: 12,
      payload: { ...payload, text: 'Codex /clear 已完成' } };
    render(<MessageBubble event={event} agentId="codex-cli" />);
    expect(screen.getByText(payload.role === 'system' ? '系统' : payload.role === 'user' ? '你' : 'Codex')).toBeTruthy();
    expect(document.querySelector('li')?.className).toContain('flex');
  });
});
