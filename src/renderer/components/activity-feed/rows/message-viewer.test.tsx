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
