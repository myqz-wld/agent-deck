import { describe, expect, it, vi } from 'vitest';
import { createRuntimeDiagnostics } from './runtime-diagnostics';
import { providerLogger } from '@hosts/server-core/provider-host-common';

describe('headless runtime diagnostic output', () => {
  it('preserves Claude timing through the actual provider logger and default formatter', () => {
    const lines: string[] = [];
    const logger = providerLogger(createRuntimeDiagnostics({
      now: () => 0, write: (line) => { lines.push(line); },
    }), 'claude-input');
    logger.info('Claude input acceptance delayed', {
      sessionId: 'private-session', messageId: 'private-message', appQueueMs: 20,
      sdkAcceptanceMs: 5100, acceptanceFrame: 'stream_event', midTurn: false,
      prompt: 'PRIVATE PROMPT', credential: 'PRIVATE CREDENTIAL', path: '/home/private/file',
    });
    expect(JSON.parse(lines[0]!)).toMatchObject({
      timestamp: '1970-01-01T00:00:00.000Z', level: 'info', scope: 'claude-input',
      event: 'claude-input-acceptance-delayed', appQueueMs: 20, sdkAcceptanceMs: 5100,
      sessionRef: expect.stringMatching(/^ref-[a-f0-9]{16}$/),
    });
    expect(lines.join('')).not.toMatch(/private|PRIVATE/);
    logger.debug('unused noisy debug', { durationMs: 1 });
    expect(lines).toHaveLength(1);
  });

  it('retains error category while excluding arbitrary messages, getters, nested payloads and URLs', () => {
    const lines: string[] = [];
    const logger = createRuntimeDiagnostics({ now: () => 0, write: (line) => { lines.push(line); } });
    const details = { durationMs: 50, payload: { secret: 'PRIVATE' }, url: 'https://private.test' };
    Object.defineProperty(details, 'count', { enumerable: true, get() { throw new Error('PRIVATE'); } });
    logger.warn('PRIVATE raw provider output', details,
      Object.assign(new Error('PRIVATE credential payload'), { code: 'ECONNRESET' }));
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: 'runtime-diagnostic', durationMs: 50, errorName: 'Error', errorCode: 'ECONNRESET',
    });
    expect(lines.join('')).not.toMatch(/PRIVATE|private|payload|credential/);
  });

  it('aggregates repeats with their maximum duration and keeps different sessions separate', () => {
    let now = 0;
    const lines: string[] = [];
    const logger = createRuntimeDiagnostics({ now: () => now, write: (line) => { lines.push(line); } });
    logger.warn('repeated failure', { sessionId: 'one', durationMs: 1 });
    for (let i = 0; i < 100; i++) logger.warn('repeated failure', { sessionId: 'one', durationMs: i });
    logger.warn('repeated failure', { sessionId: 'two', durationMs: 1 });
    expect(lines).toHaveLength(2);
    now = 60_000;
    logger.warn('repeated failure', { sessionId: 'one', durationMs: 2 });
    expect(JSON.parse(lines[2]!)).toMatchObject({ suppressedCount: 100, maxDurationMs: 99 });
    expect(JSON.parse(lines[0]!).sessionRef).not.toBe(JSON.parse(lines[1]!).sessionRef);
  });

  it('contains failing clocks and sinks', () => {
    const write = vi.fn(() => { throw new Error('closed sink'); });
    const logger = createRuntimeDiagnostics({ now: () => 0, write });
    expect(() => logger.warn('failed operation')).not.toThrow();
    expect(write).toHaveBeenCalledOnce();
    expect(() => createRuntimeDiagnostics({ now: () => NaN, write }).warn('failed operation')).not.toThrow();
  });

  it('distinguishes lifecycle phases and keeps fixed credential failures identifiable', () => {
    const lines: string[] = [];
    const logger = createRuntimeDiagnostics({ now: () => 0, write: (line) => { lines.push(line); } });
    logger.warn('Server Core session lifecycle phase failed', { phase: 'active-to-dormant' });
    logger.warn('Server Core session lifecycle phase failed', { phase: 'history-purge' });
    logger.warn('credential file became unavailable');
    expect(lines.map((line) => JSON.parse(line))).toMatchObject([
      { event: 'session-lifecycle-failed', phase: 'active-to-dormant' },
      { event: 'session-lifecycle-failed', phase: 'history-purge' },
      { event: 'credential-file-unavailable' },
    ]);
  });
});
