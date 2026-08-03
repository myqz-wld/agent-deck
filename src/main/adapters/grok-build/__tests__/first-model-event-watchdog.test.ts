import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  GrokFirstModelEventTimeoutError,
  GrokFirstModelEventWatchdog,
  isGrokModelActivity,
} from '../first-model-event-watchdog';
import type { GrokRuntime } from '../runtime-types';
import { TrustedContinuationAcceptanceController } from '@main/adapters/trusted-continuation';

function runtime(): GrokRuntime {
  return {
    applicationSessionId: 'app-session',
    nativeSessionId: 'native-session',
    process: null,
  } as GrokRuntime;
}

function update(sessionUpdate: SessionUpdate['sessionUpdate']): SessionUpdate {
  return { sessionUpdate } as SessionUpdate;
}

describe('Grok first-model-event watchdog', () => {
  it('does not count echoed input or configuration updates as model activity', () => {
    expect(isGrokModelActivity(update('user_message_chunk'))).toBe(false);
    expect(isGrokModelActivity(update('current_mode_update'))).toBe(false);
    expect(isGrokModelActivity(update('session_info_update'))).toBe(false);
    expect(isGrokModelActivity(update('agent_thought_chunk'))).toBe(true);
    expect(isGrokModelActivity(update('agent_message_chunk'))).toBe(true);
    expect(isGrokModelActivity(update('tool_call'))).toBe(true);
  });

  it('rejects a prompt that never produces model activity', async () => {
    vi.useFakeTimers();
    try {
      const watchdog = new GrokFirstModelEventWatchdog(25);
      const pending = watchdog.run(
        runtime(),
        () => new Promise<never>(() => undefined),
      );
      const assertion = expect(pending).rejects.toEqual(
        expect.objectContaining({
          name: 'GrokFirstModelEventTimeoutError',
          timeoutMs: 25,
        }),
      );

      await vi.advanceTimersByTimeAsync(25);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('disarms on model activity and leaves the normal prompt response authoritative', async () => {
    vi.useFakeTimers();
    try {
      const candidate = runtime();
      const watchdog = new GrokFirstModelEventWatchdog(25);
      let resolve!: (value: string) => void;
      const response = new Promise<string>((nextResolve) => {
        resolve = nextResolve;
      });
      const pending = watchdog.run(candidate, () => response);

      watchdog.observe(candidate, update('agent_thought_chunk'));
      await vi.advanceTimersByTimeAsync(100);
      resolve('done');

      await expect(pending).resolves.toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('crosses trusted readiness only for a model-derived update', async () => {
    const candidate = runtime();
    const acceptance = new TrustedContinuationAcceptanceController();
    candidate.trustedContinuationAcceptance = acceptance;
    const watchdog = new GrokFirstModelEventWatchdog(25);

    watchdog.observe(candidate, update('agent_message_chunk'));
    let settled = false;
    void acceptance.acceptance.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    let resolve!: () => void;
    const pending = watchdog.run(candidate, () => new Promise<void>((nextResolve) => {
      resolve = nextResolve;
    }));

    watchdog.observe(candidate, update('user_message_chunk'));
    await Promise.resolve();
    expect(settled).toBe(false);

    watchdog.observe(candidate, update('agent_message_chunk'));
    await expect(acceptance.acceptance).resolves.toEqual({
      status: 'accepted', boundary: 'model-activity',
    });
    resolve();
    await pending;
  });

  it('uses a distinct timeout error for bounded recovery handling', () => {
    expect(new GrokFirstModelEventTimeoutError(1_500).message).toContain(
      'Grok Build 已接受 prompt',
    );
  });
});
