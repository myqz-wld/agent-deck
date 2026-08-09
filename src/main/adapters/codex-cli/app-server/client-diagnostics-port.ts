import type { CodexTerminationSignals } from './process-recycle';
import type { CodexProcessDiagnosticSnapshot } from './turn-watchdog-diagnostics';

export interface CodexClientRecycleContext {
  threadId: string;
  turnId: string;
  expectedGeneration: number;
  before: CodexProcessDiagnosticSnapshot;
}

export interface CodexAppServerClientDiagnostics {
  interruptWriteFailed(input: { errorName: string; errorCode: string | null }): void;
  stderrActivity(input: {
    processGeneration: number;
    processPid: number | null;
    bytes: number;
    sanitizedTail: string | null;
    contentOmitted: boolean;
  }): void;
  stdoutParseFailed(input: {
    processGeneration: number;
    processPid: number | null;
    bytes: number;
    errorName: string;
  }): void;
  mcpStartupObserved(input: { level: 'info' | 'warn'; message: string }): void;
  notificationListenerFailed(error: unknown): void;
  recycleSkipped(
    context: CodexClientRecycleContext,
    outcome: 'generation_mismatch' | 'process_missing',
  ): void;
  recycleDetachFailed(
    context: CodexClientRecycleContext,
    after: CodexProcessDiagnosticSnapshot,
    interruptWrite: 'sent' | 'failed',
  ): void;
  recycleTerminationFailed(
    context: CodexClientRecycleContext,
    signal: 'SIGTERM' | 'SIGKILL',
  ): void;
  recycleCompleted(
    context: CodexClientRecycleContext,
    after: CodexProcessDiagnosticSnapshot,
    interruptWrite: 'sent' | 'failed',
    termination: CodexTerminationSignals,
  ): void;
}

export const NOOP_CODEX_CLIENT_DIAGNOSTICS: CodexAppServerClientDiagnostics = Object.freeze({
  interruptWriteFailed: () => undefined,
  stderrActivity: () => undefined,
  stdoutParseFailed: () => undefined,
  mcpStartupObserved: () => undefined,
  notificationListenerFailed: () => undefined,
  recycleSkipped: () => undefined,
  recycleDetachFailed: () => undefined,
  recycleTerminationFailed: () => undefined,
  recycleCompleted: () => undefined,
});

export function invokeCodexClientDiagnostic(observe: () => void): void {
  try {
    observe();
  } catch {
    // Diagnostics cannot alter process I/O, notification delivery, or generation retirement.
  }
}
