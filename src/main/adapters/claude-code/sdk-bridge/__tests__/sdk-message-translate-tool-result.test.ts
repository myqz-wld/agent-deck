import { describe, expect, it, vi } from 'vitest';
import { translateSdkMessage } from '../sdk-message-translate';
import { makeInternalSession } from '../types';

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: vi.fn(() => null),
    setModel: vi.fn(),
    setPermissionMode: vi.fn(),
  },
}));

vi.mock('@main/event-bus', () => ({
  eventBus: { emit: vi.fn() },
}));

describe('Claude SDK structured tool results', () => {
  it('uses the full structured result for a single tool result', () => {
    const internal = makeInternalSession({ cwd: '/repo', applicationSid: 'sid-tool' });
    internal.toolUseNames.set('tool-1', 'Agent');
    const emit = vi.fn();

    translateSdkMessage(
      emit,
      'sid-tool',
      {
        type: 'user',
        tool_use_result: {
          result: 'review complete',
          agentId: 'agent-7',
          usage: { tool_uses: 4 },
        },
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: 'review complete\nagentId: agent-7',
            },
          ],
        },
      },
      internal,
    );

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'tool-use-end',
      payload: {
        toolUseId: 'tool-1',
        toolName: 'Agent',
        toolResult: {
          result: 'review complete',
          agentId: 'agent-7',
          usage: { tool_uses: 4 },
        },
        status: 'completed',
      },
    }));
  });

  it('keeps per-block content when one message contains multiple tool results', () => {
    const internal = makeInternalSession({ cwd: '/repo', applicationSid: 'sid-batch' });
    internal.toolUseNames.set('tool-a', 'Read');
    internal.toolUseNames.set('tool-b', 'Read');
    const emit = vi.fn();

    translateSdkMessage(
      emit,
      'sid-batch',
      {
        type: 'user',
        tool_use_result: { ambiguous: true },
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-a', content: 'a' },
            { type: 'tool_result', tool_use_id: 'tool-b', content: 'b' },
          ],
        },
      },
      internal,
    );

    const endings = emit.mock.calls
      .map(([event]) => event)
      .filter((event) => event.kind === 'tool-use-end');
    expect(endings.map((event) => event.payload.toolResult)).toEqual(['a', 'b']);
  });
});
