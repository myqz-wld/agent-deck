import { beforeEach, describe, expect, it, vi } from 'vitest';
import { translateSdkMessage } from '../sdk-message-translate';
import { makeInternalSession } from '../types';
import { sessionRepo } from '@main/store/session-repo';

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: vi.fn(),
    setModel: vi.fn(),
    setPermissionMode: vi.fn(),
  },
}));

vi.mock('@main/event-bus', () => ({
  eventBus: {
    emit: vi.fn(),
  },
}));

describe('Claude SDK init runtime model', () => {
  beforeEach(() => {
    vi.mocked(sessionRepo.get).mockReset();
    vi.mocked(sessionRepo.setModel).mockReset();
    vi.mocked(sessionRepo.get).mockReturnValue(null);
  });

  it('uses only system/init.model and ignores assistant/status model fields', () => {
    const internal = makeInternalSession({ cwd: '/repo', applicationSid: 'sid-model' });
    const emit = vi.fn();

    translateSdkMessage(
      emit,
      'sid-model',
      { type: 'system', subtype: 'init', model: 'claude-opus-4-8' },
      internal,
    );
    expect(internal.runtimeModel).toBe('claude-opus-4-8');

    translateSdkMessage(
      emit,
      'sid-model',
      {
        type: 'assistant',
        message: { model: 'fallback-model', content: [] },
      },
      internal,
    );
    translateSdkMessage(
      emit,
      'sid-model',
      { type: 'system', subtype: 'status', model: 'status-model' },
      internal,
    );

    expect(internal.runtimeModel).toBe('claude-opus-4-8');
  });

  it('ignores blank init model reports', () => {
    const internal = makeInternalSession({ cwd: '/repo', applicationSid: 'sid-blank' });
    translateSdkMessage(
      vi.fn(),
      'sid-blank',
      { type: 'system', subtype: 'init', model: '   ' },
      internal,
    );
    expect(internal.runtimeModel).toBeUndefined();
  });
});
