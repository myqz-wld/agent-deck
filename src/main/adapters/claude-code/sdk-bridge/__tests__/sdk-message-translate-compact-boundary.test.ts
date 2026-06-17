import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: vi.fn(),
    setPermissionMode: vi.fn(),
  },
}));

vi.mock('@main/event-bus', () => ({
  eventBus: {
    emit: vi.fn(),
  },
}));

import { translateSdkMessage } from '../sdk-message-translate';
import { makeInternalSession } from '../types';
import type { AgentEvent } from '@shared/types';
import { sessionRepo } from '@main/store/session-repo';

function setup() {
  const events: AgentEvent[] = [];
  const emit = (event: AgentEvent): void => {
    events.push(event);
  };
  const internal = makeInternalSession({ cwd: '/tmp', applicationSid: 'sid-compact' });
  return { events, emit, internal };
}

describe('translateSdkMessage — Claude compact_boundary display', () => {
  beforeEach(() => {
    vi.mocked(sessionRepo.get).mockReset();
    vi.mocked(sessionRepo.setPermissionMode).mockReset();
  });

  it('renders SDK compact_boundary as a visible timeline message', () => {
    const { events, emit, internal } = setup();

    translateSdkMessage(
      emit,
      'sid-compact',
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: {
          trigger: 'auto',
          pre_tokens: 123456,
          post_tokens: 34567,
          duration_ms: 1500,
        },
      },
      internal,
    );

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('message');
    expect(events[0].payload).toMatchObject({ role: 'assistant' });
    const text = (events[0].payload as { text: string }).text;
    expect(text).toContain('上下文已压缩');
    expect(text).toContain('触发：自动');
    expect(text).toContain('Token：123,456 → 34,567');
    expect(text).toContain('耗时：1,500ms');
  });

  it('keeps permissionMode sync when a status frame also reports compaction failure', () => {
    const { events, emit, internal } = setup();
    vi.mocked(sessionRepo.get)
      .mockReturnValueOnce({ id: 'sid-compact', permissionMode: 'default' } as never)
      .mockReturnValueOnce({ id: 'sid-compact', permissionMode: 'plan' } as never);

    translateSdkMessage(
      emit,
      'sid-compact',
      {
        type: 'system',
        subtype: 'status',
        permissionMode: 'plan',
        compact_result: 'failed',
        compact_error: 'summary model failed',
      },
      internal,
    );

    expect(internal.permissionMode).toBe('plan');
    expect(vi.mocked(sessionRepo.setPermissionMode)).toHaveBeenCalledWith('sid-compact', 'plan');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('message');
    expect((events[0].payload as { text: string; error?: boolean }).text).toBe(
      '⚠ 上下文压缩失败：summary model failed',
    );
    expect((events[0].payload as { error?: boolean }).error).toBe(true);
  });
});
