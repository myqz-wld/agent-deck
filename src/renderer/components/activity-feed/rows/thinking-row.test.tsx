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
  it('uses the original THINKING copy for Claude Code sessions', () => {
    const { container } = render(<ThinkingBubble event={thinkingEvent()} agentId="claude-code" />);
    expect(container.textContent).toContain('Claude');
    expect(container.textContent).toContain('THINKING');
  });

  it('uses the original reasoning-summary copy for Codex CLI sessions', () => {
    const { container } = render(<ThinkingBubble event={thinkingEvent()} agentId="codex-cli" />);
    expect(container.textContent).toContain('Codex');
    expect(container.textContent).toContain('REASONING SUMMARY');
  });

  it('uses the original inline disclosure for long thinking text', () => {
    const text = `${'推理'.repeat(301)}完整结尾`;
    const { container } = render(
      <ThinkingBubble event={thinkingEvent(text)} agentId="codex-cli" />,
    );
    const trigger = screen.getByRole('button', { name: `展开（${text.length} 字）` });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.max-h-56')).toBeTruthy();
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: '收起' }).getAttribute('aria-expanded'))
      .toBe('true');
    expect(container.querySelector('.max-h-56')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: '展开思考详情' })).toBeNull();
  });
});
