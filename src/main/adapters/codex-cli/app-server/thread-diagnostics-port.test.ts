import { describe, expect, it, vi } from 'vitest';
import {
  NOOP_CODEX_THREAD_DIAGNOSTICS,
  invokeCodexThreadDiagnostic,
} from './thread-diagnostics-port';

describe('Codex thread diagnostics port', () => {
  it('invokes a supplied diagnostic observation exactly once', () => {
    const observe = vi.fn();

    invokeCodexThreadDiagnostic(observe);

    expect(observe).toHaveBeenCalledOnce();
  });

  it('contains diagnostic failures', () => {
    expect(() => invokeCodexThreadDiagnostic(() => {
      throw new Error('diagnostics failed');
    })).not.toThrow();
  });

  it('provides a complete no-op default', () => {
    const diagnostic = { phase: 'test' };

    expect(() => {
      NOOP_CODEX_THREAD_DIAGNOSTICS.firstModelEventReceived(diagnostic);
      NOOP_CODEX_THREAD_DIAGNOSTICS.watchdogArmed(diagnostic);
      NOOP_CODEX_THREAD_DIAGNOSTICS.watchdogTimedOut(diagnostic);
    }).not.toThrow();
  });
});
