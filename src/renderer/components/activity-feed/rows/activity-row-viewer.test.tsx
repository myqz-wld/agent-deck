// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { AgentEvent } from '@shared/types';
import { ActivityFeed, ActivityRow } from '../index';

const messageRender = vi.fn();
vi.mock('./message-row', () => ({
  MessageBubble: () => {
    messageRender();
    return <li>message</li>;
  },
}));
vi.mock('./thinking-row', () => ({ ThinkingBubble: () => <li>thinking</li> }));
vi.mock('./tool-row', () => ({
  ToolStartRow: () => <li>tool start</li>,
  ToolEndRow: () => <li>tool end</li>,
}));
vi.mock('./simple-row', () => ({ SimpleRow: () => <li>simple</li> }));

afterEach(() => {
  cleanup();
  messageRender.mockClear();
});

describe('ActivityRow scalar memo boundary', () => {
  it('does not rerender a stable row when its scalar derivations stay unchanged', () => {
    const event: AgentEvent = {
      sessionId: 's',
      agentId: 'claude-code',
      kind: 'message',
      payload: { text: 'stable' },
      ts: 1,
    };
    const resolvePermission = vi.fn();
    const resolveAsk = vi.fn();
    const resolveExitPlan = vi.fn();
    const resolveDiffReview = vi.fn();
    const view = render(
      <ActivityRow
        event={event}
        sessionId="s"
        agentId="claude-code"
        isSdk
        stillPending={false}
        wasCancelled={false}
        resolvePermission={resolvePermission}
        resolveAsk={resolveAsk}
        resolveExitPlan={resolveExitPlan}
        resolveDiffReview={resolveDiffReview}
      />,
    );
    expect(messageRender).toHaveBeenCalledTimes(1);
    view.rerender(
      <ActivityRow
        event={event}
        sessionId="s"
        agentId="claude-code"
        isSdk
        stillPending={false}
        wasCancelled={false}
        resolvePermission={resolvePermission}
        resolveAsk={resolveAsk}
        resolveExitPlan={resolveExitPlan}
        resolveDiffReview={resolveDiffReview}
      />,
    );
    expect(messageRender).toHaveBeenCalledTimes(1);
  });

  it('keeps history loader details out of the user-facing error', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listEvents: vi.fn().mockRejectedValue(new Error('database path leaked')),
      },
    });

    render(<ActivityFeed sessionId="history-error" agentId="claude-code" isSdk={false} />);

    expect(await screen.findByText('读取活动记录失败，请稍后重试。')).toBeTruthy();
    expect(document.body.textContent).not.toContain('database path leaked');
  });
});
