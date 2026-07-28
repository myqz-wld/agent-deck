// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { ThinkingBubble } from './thinking-row';

afterEach(() => cleanup());

function thinkingEvent(text = ''): AgentEvent {
  return {
    sessionId: 's',
    agentId: 'claude-code',
    kind: 'thinking',
    payload: { text },
    ts: 0,
  };
}

describe('ThinkingBubble adapter-aware copy', () => {
  it('uses concise Chinese thinking copy for Claude Code sessions', () => {
    const { container } = render(<ThinkingBubble event={thinkingEvent()} agentId="claude-code" />);
    expect(container.textContent).toContain('Claude Code');
    expect(container.textContent).toContain('思考');
    expect(container.textContent).not.toContain('THINKING');
  });

  it('uses concise Chinese reasoning copy for Codex CLI sessions', () => {
    const { container } = render(<ThinkingBubble event={thinkingEvent()} agentId="codex-cli" />);
    expect(container.textContent).toContain('Codex CLI');
    expect(container.textContent).toContain('推理摘要');
    expect(container.textContent).not.toContain('REASONING SUMMARY');
  });

  it('closes an open viewer when same-millisecond thinking changes identity', () => {
    const view = render(
      <ThinkingBubble event={thinkingEvent('第一段推理')} agentId="codex-cli" />,
    );
    fireEvent.click(screen.getByRole('button', { name: '展开思考详情' }));
    expect(screen.getByRole('dialog').textContent).toContain('第一段推理');
    view.rerender(
      <ThinkingBubble event={thinkingEvent('第二段推理')} agentId="codex-cli" />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开思考详情' }));
    expect(screen.getByRole('dialog').textContent).toContain('第二段推理');
  });
});
