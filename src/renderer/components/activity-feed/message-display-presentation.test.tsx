// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { AgentEvent } from '@shared/types';
import { presentMessageDisplays } from './message-display-presentation';
import { ActivityRecordsView } from './records-view';

function event(kind: AgentEvent['kind'], payload: unknown, ts: number): AgentEvent {
  return { sessionId: 'session', agentId: 'claude-code', kind, payload, ts, source: 'hook', hookOrigin: 'cli' };
}
function display(delta: string, index = 0, final = false, message = 'message-a'): AgentEvent {
  return event('message-display', { promptId: 'prompt-a', turnId: 'turn-a', messageId: message, index, final, delta }, 2 + index);
}
function stop(text: string): AgentEvent[] {
  return [event('message', { role: 'assistant', text, metadata: { promptId: 'prompt-a', final: true } }, 8),
    event('finished', { ok: true, backgroundTasks: [], sessionCrons: [] }, 8)];
}
afterEach(cleanup);

describe('external Claude display messages', () => {
  it('coalesces ordered deltas, repeated deliveries and an empty final flush into one bubble', () => {
    const first = display('First\n');
    const second = display('Second\n', 1);
    const end = display('', 2, true);
    const result = presentMessageDisplays([end, second, { ...first, ts: 3 }, first]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'message', payload: { text: 'First\nSecond\n' } });
    expect(first.kind).toBe('message-display');
  });

  it('shows only the final reply and completion with no empty task disclosure', () => {
    const events = [...stop('First\nSecond'), display('Second', 1, true), display('First\n')];
    const { container } = render(<ActivityRecordsView events={events} loaded loadError={null}
      sessionId="session" agentId="claude-code" isSdk={false} />);
    expect(container.querySelectorAll('ol > li')).toHaveLength(2);
    expect(screen.queryByText(/显示消息/)).toBeNull();
    expect(screen.queryByText('查看详情')).toBeNull();
    expect(container.textContent?.match(/Second/g)).toHaveLength(1);
  });

  it('matches legacy hooks only inside an observed user-turn boundary', () => {
    const user = event('message', { role: 'user', text: 'hello' }, 1);
    const shown = display('Hello', 0, true);
    shown.payload = { ...shown.payload as object, promptId: undefined, turnId: undefined };
    const final = stop('Hello')[0];
    final.payload = { role: 'assistant', text: 'Hello', metadata: { final: true } };
    expect(presentMessageDisplays([final, shown, user])).toHaveLength(2);
    expect(presentMessageDisplays([final, shown])).toHaveLength(2);
  });

  it('preserves identical text in different prompts, sessions and subagents', () => {
    const final = stop('Hello')[0];
    for (const patch of [{ promptId: 'another-prompt' }, { agentId: 'subagent-a' }]) {
      const shown = display('Hello', 0, true);
      shown.payload = { ...shown.payload as object, ...patch };
      expect(presentMessageDisplays([final, shown])).toHaveLength(2);
    }
    expect(presentMessageDisplays([final, { ...display('Hello', 0, true), sessionId: 'other-session' }])).toHaveLength(2);
  });

  it('preserves distinct completed messages with identical text in one prompt', () => {
    const shown = display('Hello', 0, true, 'earlier-message');
    const latest = { ...display('Hello', 0, true, 'latest-message'), ts: 5 };
    const result = presentMessageDisplays([stop('Hello')[0], latest, shown]);
    expect(result).toHaveLength(2);
  });

  it('keeps a completed prefix message and uncorrelated partial history', () => {
    const final = stop('Hello world')[0];
    expect(presentMessageDisplays([final, display('Hello', 0, true)])).toHaveLength(2);
    expect(presentMessageDisplays([final, display('world', 4, false)])).toHaveLength(2);
    expect(presentMessageDisplays([final, display('Hello', 0, false)])).toHaveLength(1);
  });

  it('keeps the bubble identity stable as new chunks and the final reply arrive', () => {
    const first = display('Hello');
    const before = presentMessageDisplays([first])[0].payload as { displayMessageId: string };
    const after = presentMessageDisplays([stop('Hello world')[0], display(' world', 1, true), first])[0].payload as { displayMessageId: string };
    expect(after.displayMessageId).toBe(before.displayMessageId);
  });
});
