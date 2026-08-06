import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_FIRST_MESSAGE_TIMEOUT_MS,
  waitForClaudeStreamIdCore,
  type ClaudeStreamWaitHost,
} from './stream-wait-core';
import { makeInternalSession } from './types';

afterEach(() => {
  vi.useRealTimers();
});

function host(): ClaudeStreamWaitHost & {
  now: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  return {
    agentId: 'claude-core',
    now: vi.fn(() => 9000),
    warn: vi.fn(),
  };
}

describe('Claude stream first-message wait Core', () => {
  it('falls back to the stable resume id and interrupts the provider once', async () => {
    vi.useFakeTimers();
    const internal = makeInternalSession({
      cwd: '/workspace',
      applicationSid: 'resume-sid',
    });
    const interrupt = vi.fn(() => Promise.resolve());
    internal.query = { interrupt } as unknown as Query;
    const sessions = new Map([['temp-sid', internal]]);
    const emit = vi.fn();
    const ports = host();

    const result = waitForClaudeStreamIdCore(
      { sessions, emit },
      internal,
      'temp-sid',
      'resume-sid',
      () => new Promise(() => undefined),
      ports,
    );
    await vi.advanceTimersByTimeAsync(CLAUDE_FIRST_MESSAGE_TIMEOUT_MS);

    await expect(result).resolves.toBe('resume-sid');
    expect(interrupt).toHaveBeenCalledOnce();
    expect(internal.expectedClose).toBe(true);
    expect(internal.interruptFired).toBe(true);
    expect(internal.applicationSid).toBe('resume-sid');
    expect(internal.cliSessionId).toBe('resume-sid');
    expect(sessions.has('temp-sid')).toBe(false);
    expect(sessions.get('resume-sid')).toBe(internal);
    expect(emit).toHaveBeenCalledWith({
      sessionId: 'resume-sid',
      agentId: 'claude-core',
      kind: 'message',
      payload: expect.objectContaining({ error: true }),
      ts: 9000,
      source: 'sdk',
    });
    expect(ports.warn).toHaveBeenCalledWith(expect.stringContaining('resume-sid'));
  });

  it('cancels the fallback when the first provider id wins', async () => {
    vi.useFakeTimers();
    const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'temp-sid' });
    const emit = vi.fn();
    const ports = host();

    const result = waitForClaudeStreamIdCore(
      { sessions: new Map([['temp-sid', internal]]), emit },
      internal,
      'temp-sid',
      undefined,
      async (onFirstId) => {
        onFirstId('provider-sid');
        return 'provider-sid';
      },
      ports,
    );

    await expect(result).resolves.toBe('provider-sid');
    expect(vi.getTimerCount()).toBe(0);
    expect(emit).not.toHaveBeenCalled();
    expect(ports.warn).not.toHaveBeenCalled();
  });

  it('uses the last consume result or temporary id when the stream ends first', async () => {
    vi.useFakeTimers();
    const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'temp-sid' });
    const ports = host();

    await expect(waitForClaudeStreamIdCore(
      { sessions: new Map(), emit: vi.fn() },
      internal,
      'temp-sid',
      undefined,
      async () => null,
      ports,
    )).resolves.toBe('temp-sid');
    expect(vi.getTimerCount()).toBe(0);
  });
});
