import { describe, expect, it } from 'vitest';
import {
  buildCodexRecycleDiagnostic,
  buildCodexTurnWatchdogDiagnostic,
  sanitizeCodexStderrTail,
} from './turn-watchdog-diagnostics';

describe('Codex turn watchdog diagnostics', () => {
  it('builds a deterministic allowlisted timeout snapshot', () => {
    const snapshot = buildCodexTurnWatchdogDiagnostic({
      phase: 'timeout',
      threadId: 'thread-123',
      turnId: 'turn-456',
      acceptanceSource: 'notification',
      acceptedAtMs: 1_000,
      deadlineAtMs: 91_000,
      nowMs: 91_250,
      responsePending: true,
      notificationCount: 3,
      lastScopedNotificationMethod: 'item/reasoning/summaryTextDelta',
      lastScopedNotificationAtMs: 90_500,
      process: {
        processGeneration: 7,
        processPid: 4321,
        processAlive: true,
        pendingRpcCount: 2,
        stderrTailBytes: 45,
        hasStderrTail: true,
      },
    });

    expect(snapshot).toEqual({
      event: 'codex_turn_watchdog',
      phase: 'timeout',
      threadId: 'thread-123',
      turnId: 'turn-456',
      acceptanceSource: 'notification',
      acceptedAtMs: 1_000,
      deadlineAtMs: 91_000,
      elapsedMs: 90_250,
      deadlineRemainingMs: 0,
      responsePending: true,
      notificationCount: 3,
      lastScopedNotificationMethod: 'item/reasoning/summaryTextDelta',
      lastScopedNotificationAgeMs: 750,
      processGeneration: 7,
      processPid: 4321,
      processAlive: true,
      pendingRpcCount: 2,
      stderrTailBytes: 45,
      hasStderrTail: true,
    });
  });

  it('redacts stderr and drops payload-bearing or unclassified lines', () => {
    const secret = 'SUPER_SECRET_PROMPT_VALUE';
    const tail = sanitizeCodexStderrTail([
      `random stderr containing ${secret}`,
      `ERROR codex_core prompt=${secret}`,
      'WARN codex_app_server transport disconnected Bearer abcdefghijklmnopqrstuvwxyz',
      'INFO codex_core request failed at https://example.test/path?token=secret',
      'DEBUG codex_core file /Users/alice/private/project.ts failed',
      'TRACE codex_core opaque abcdefghijklmnopqrstuvwxyz0123456789',
    ].join('\n'));

    expect(tail).toContain('Bearer [redacted]');
    expect(tail).toContain('[url redacted]');
    expect(tail).toContain('[path redacted]');
    expect(tail).toContain('[opaque redacted]');
    expect(tail).not.toContain(secret);
    expect(tail).not.toContain('prompt=');
    expect(tail).not.toContain('alice');
    expect(tail!.length).toBeLessThanOrEqual(1_024);
  });

  it('rejects unsafe identifiers and exposes no arbitrary payload fields', () => {
    const snapshot = buildCodexRecycleDiagnostic({
      threadId: 'thread-1\nprompt=DO_NOT_LOG',
      turnId: 'turn-1 payload=DO_NOT_LOG',
      outcome: 'completed',
      expectedGeneration: 1,
      actualGeneration: 2,
      processPid: 99,
      processAliveBefore: true,
      processAliveAfter: false,
      pendingRpcCountBefore: 4,
      pendingRpcCountAfter: 0,
      interruptWrite: 'sent',
      sigtermSent: true,
      sigkillScheduled: true,
      stderrTailBytes: 0,
      hasStderrTail: false,
    });
    const encoded = JSON.stringify(snapshot);

    expect(snapshot.threadId).toBe('[invalid]');
    expect(snapshot.turnId).toBe('[invalid]');
    expect(encoded).not.toContain('DO_NOT_LOG');
    expect(encoded).not.toContain('prompt=');
    expect(Object.keys(snapshot)).not.toContain('payload');
    expect(Object.keys(snapshot)).not.toContain('input');
    expect(Object.keys(snapshot)).not.toContain('env');
  });
});
