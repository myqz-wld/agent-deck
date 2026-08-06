export type CodexThreadWatchdogDiagnostic = Record<
  string,
  string | number | boolean | null
>;

export interface CodexThreadDiagnostics {
  firstModelEventReceived(diagnostic: CodexThreadWatchdogDiagnostic): void;
  watchdogArmed(diagnostic: CodexThreadWatchdogDiagnostic): void;
  watchdogTimedOut(diagnostic: CodexThreadWatchdogDiagnostic): void;
}

export const NOOP_CODEX_THREAD_DIAGNOSTICS: CodexThreadDiagnostics = Object.freeze({
  firstModelEventReceived: () => undefined,
  watchdogArmed: () => undefined,
  watchdogTimedOut: () => undefined,
});

export function invokeCodexThreadDiagnostic(observe: () => void): void {
  try {
    observe();
  } catch {
    // Diagnostics cannot alter provider event delivery or watchdog retirement.
  }
}
