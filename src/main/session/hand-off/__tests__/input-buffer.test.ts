import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, SessionRecord } from '@shared/types';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  setActivity: vi.fn(),
  emitBus: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: { get: mocks.get, setActivity: mocks.setActivity },
}));
vi.mock('@main/event-bus', () => ({ eventBus: { emit: mocks.emitBus } }));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn: mocks.warn }) },
}));

import { handOffCutoverCoordinator } from '../cutover-coordinator';
import { bufferHandOffSourceInput } from '../input-buffer';

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'source',
    agentId: 'claude-code',
    cwd: '/tmp',
    title: 'source',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 2,
    endedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

describe('handoff input rollback activity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks a successfully replayed source working before the cutover gate disappears', async () => {
    const source = session();
    const updated = session({ activity: 'working', lastEventAt: 3 });
    mocks.get.mockReturnValueOnce(source).mockReturnValueOnce(updated);
    const replay = vi.fn(async () => undefined);
    const emit = vi.fn<(event: AgentEvent) => void>();
    const lease = handOffCutoverCoordinator.tryAcquire('source')!;

    expect(bufferHandOffSourceInput({
      sourceSessionId: 'source',
      agentId: 'claude-code',
      text: 'replay me',
      emit,
      replay,
    })).toBe(true);

    lease.release();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mocks.setActivity).toHaveBeenCalledOnce());
    expect(mocks.setActivity).toHaveBeenCalledWith('source', 'working', expect.any(Number));
    expect(mocks.emitBus).toHaveBeenCalledWith('session-upserted', updated);
  });

  it('does not retry provider input when the best-effort activity update fails', async () => {
    mocks.get.mockReturnValue(session());
    mocks.setActivity.mockImplementation(() => {
      throw new Error('db busy');
    });
    const replay = vi.fn(async () => undefined);
    const emit = vi.fn<(event: AgentEvent) => void>();
    const lease = handOffCutoverCoordinator.tryAcquire('source-marker-failure')!;

    bufferHandOffSourceInput({
      sourceSessionId: 'source-marker-failure',
      agentId: 'claude-code',
      text: 'exactly once',
      emit,
      replay,
    });
    lease.release();

    await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledOnce());
    expect(replay).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledOnce();
  });

  it('warns that a timed-out replay may still settle before suggesting a resend', async () => {
    vi.useFakeTimers();
    try {
      const emit = vi.fn<(event: AgentEvent) => void>();
      const lease = handOffCutoverCoordinator.tryAcquire('source-timeout-copy')!;
      bufferHandOffSourceInput({
        sourceSessionId: 'source-timeout-copy',
        agentId: 'claude-code',
        text: 'slow replay',
        emit,
        replay: () => new Promise<void>(() => undefined),
      });

      lease.release();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit.mock.calls[1][0]).toEqual(expect.objectContaining({
        payload: expect.objectContaining({
          text: expect.stringContaining('可能仍在恢复'),
          error: true,
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });
});
