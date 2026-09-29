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
  it('preserves image blocks even when the SDK also supplies a structured tool result', () => {
    const internal = makeInternalSession({ cwd: '/repo', applicationSid: 'sid-image' });
    internal.toolUseNames.set('image-call', 'Read');
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'image-bytes' } };
    const emit = vi.fn();
    translateSdkMessage(emit, 'sid-image', { type: 'user', tool_use_result: { note: 'read image' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'image-call', content: [image] }] } }, internal);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tool-use-end',
      payload: expect.objectContaining({ toolResult: { note: 'read image' }, imageInputs: [image] }) }));
  });

  it('preserves direct assistant image blocks', () => {
    const internal = makeInternalSession({ cwd: '/repo', applicationSid: 'sid-image' });
    const source = { type: 'base64', media_type: 'image/png', data: 'image-bytes' };
    const emit = vi.fn();
    translateSdkMessage(emit, 'sid-image', { type: 'assistant', message: { content: [{ type: 'image', source }] } }, internal);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'message',
      payload: expect.objectContaining({ role: 'assistant', imageInputs: [{ source }] }) }));
  });

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
    expect(internal.toolUseNames).toHaveLength(0);
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
    expect(internal.toolUseNames).toHaveLength(0);
  });
});
