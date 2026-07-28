// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import type { AgentEvent } from '@shared/types';
import { MessageBubble } from './message-row';
import {
  createMessageContentPayload,
  normalizeAgentMessage,
} from '../viewers/message-content';

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

describe('MessageBubble full viewer', () => {
  it('preserves render mode, attachments, and wire metadata in the selected message', () => {
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
    const trigger = screen.getByRole('button', { name: '展开消息详情' });
    expect(trigger.className).toContain('h-11');
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: '你的消息详情' });
    expect(dialog.textContent).toContain('Reviewer · Claude Code');
    expect(within(dialog).getByRole('img', { name: '附件图片 1' })).toBeTruthy();
    expect(within(dialog).queryByTestId('markdown')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '显示 Markdown' }));
    expect(within(dialog).getByTestId('markdown').textContent).toBe('# Full message');
  });

  it('closes an open viewer when a same-millisecond message changes identity', () => {
    const commonPrefix = '123456789012345678901234';
    const first: AgentEvent = {
      sessionId: 'session-1',
      agentId: 'codex-cli',
      kind: 'message',
      payload: { role: 'assistant', text: `${commonPrefix}A first payload` },
      ts: 7,
    };
    const second: AgentEvent = {
      ...first,
      payload: { role: 'assistant', text: `${commonPrefix}B second payload` },
    };
    const view = render(<MessageBubble event={first} agentId="codex-cli" />);
    fireEvent.click(screen.getByRole('button', { name: '展开消息详情' }));
    expect(screen.getByRole('dialog').textContent).toContain('first payload');

    view.rerender(<MessageBubble event={second} agentId="codex-cli" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开消息详情' }));
    expect(screen.getByRole('dialog').textContent).toContain('second payload');
  });

  it('keeps complete wire and hand-off metadata without fictional attachment references', () => {
    const event: AgentEvent = {
      sessionId: 'session-1',
      agentId: 'codex-cli',
      kind: 'message',
      payload: {
        role: 'user',
        text: '[from Reviewer @ claude-code][msg message-9][sid source-9]\nBody',
        handOff: {
          mode: 'session',
          fromCallerSid: 'caller-9',
          sourceMaxEventId: 99,
        },
        attachments: [{
          kind: 'uploaded',
          path: '/uploads/image.png',
          mime: 'image/png',
          bytes: 42,
        }],
      },
      ts: 9,
    };
    const payload = createMessageContentPayload(normalizeAgentMessage(event), 'plaintext');
    expect(payload.attachments[0]?.reference).toBeUndefined();
    expect(payload.metadata).toMatchObject({
      wireFrom: 'Reviewer',
      wireAdapter: 'Claude Code',
      wireMessageId: 'message-9',
      wireSenderSessionId: 'source-9',
      handOffSourceSessionId: 'caller-9',
      handOffSourceEventId: 99,
    });
  });
});
