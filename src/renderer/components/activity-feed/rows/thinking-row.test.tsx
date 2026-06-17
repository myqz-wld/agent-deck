// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { ThinkingBubble } from './thinking-row';

function thinkingEvent(): AgentEvent {
  return {
    sessionId: 's',
    agentId: 'claude-code',
    kind: 'thinking',
    payload: { text: '' },
    ts: 0,
  };
}

describe('ThinkingBubble adapter-aware copy', () => {
  it('uses THINKING for Claude-family sessions', () => {
    const { container } = render(<ThinkingBubble event={thinkingEvent()} agentId="claude-code" />);
    expect(container.textContent).toContain('THINKING');
    expect(container.textContent).not.toContain('REASONING SUMMARY');
  });

  it('keeps REASONING SUMMARY for Codex sessions', () => {
    const { container } = render(<ThinkingBubble event={thinkingEvent()} agentId="codex-cli" />);
    expect(container.textContent).toContain('REASONING SUMMARY');
  });
});
