import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildClaudeRuntimeMetadataHooks } from '../runtime-metadata-sync';
import { makeInternalSession } from '../types';
import { sessionRepo } from '@main/store/session-repo';
import { eventBus } from '@main/event-bus';

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: vi.fn(),
    setModel: vi.fn(),
    setThinking: vi.fn(),
  },
}));

vi.mock('@main/event-bus', () => ({
  eventBus: {
    emit: vi.fn(),
  },
}));

describe('Claude SDK runtime metadata sync', () => {
  beforeEach(() => {
    vi.mocked(sessionRepo.get).mockReset();
    vi.mocked(sessionRepo.setModel).mockReset();
    vi.mocked(sessionRepo.setThinking).mockReset();
    vi.mocked(eventBus.emit).mockReset();
  });

  it('Stop and StopFailure hooks only observe valid SDK effort and always return an empty object', async () => {
    const internal = makeInternalSession({ cwd: '/repo', applicationSid: 'sid-hook' });
    vi.mocked(sessionRepo.get).mockReturnValue(null);
    const hooks = buildClaudeRuntimeMetadataHooks(internal);
    const stop = hooks.Stop![0].hooks[0];
    const stopFailure = hooks.StopFailure![0].hooks[0];
    const options = { signal: new AbortController().signal };

    await expect(
      stop(
        { hook_event_name: 'Stop', effort: { level: 'ultra' } } as never,
        undefined,
        options,
      ),
    ).resolves.toEqual({});
    expect(internal.runtimeEffort).toBeUndefined();

    await expect(
      stopFailure(
        { hook_event_name: 'StopFailure', effort: { level: 'max' } } as never,
        undefined,
        options,
      ),
    ).resolves.toEqual({});
    expect(internal.runtimeEffort).toBe('max');

    await expect(
      stop(
        {
          hook_event_name: 'Stop',
          agent_id: 'subagent-1',
          effort: { level: 'low' },
        } as never,
        undefined,
        options,
      ),
    ).resolves.toEqual({});
    expect(internal.runtimeEffort).toBe('max');

    await expect(
      stop(
        {
          hook_event_name: 'Stop',
          get effort() {
            throw new Error('malformed hook payload');
          },
        } as never,
        undefined,
        options,
      ),
    ).resolves.toEqual({});
    expect(internal.runtimeEffort).toBe('max');
  });
});
