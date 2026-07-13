import type { CodexTerminationSignals } from './process-recycle';
import {
  buildCodexRecycleDiagnostic,
  type CodexProcessDiagnosticSnapshot,
  type CodexRecycleDiagnosticInput,
} from './turn-watchdog-diagnostics';

interface RecycleLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface RecycleContext {
  threadId: string;
  turnId: string;
  expectedGeneration: number;
  before: CodexProcessDiagnosticSnapshot;
}

export function logCodexRecycleSkipped(
  logger: RecycleLogger,
  context: RecycleContext,
  outcome: 'generation_mismatch' | 'process_missing',
): void {
  logger.debug('[codex-app-server] watchdog recycle fenced', build(context, {
    outcome,
    actualGeneration: context.before.processGeneration,
    processAliveAfter: context.before.processAlive,
    pendingRpcCountAfter: context.before.pendingRpcCount,
  }));
}

export function logCodexRecycleDetachFailure(
  logger: RecycleLogger,
  context: RecycleContext,
  after: CodexProcessDiagnosticSnapshot,
  interruptWrite: 'sent' | 'failed',
): void {
  logger.error('[codex-app-server] watchdog recycle failed', build(context, {
    outcome: 'detach_failed',
    actualGeneration: after.processGeneration,
    processAliveAfter: after.processAlive,
    pendingRpcCountAfter: after.pendingRpcCount,
    interruptWrite,
  }));
}

export function logCodexRecycleCompleted(
  logger: RecycleLogger,
  context: RecycleContext,
  after: CodexProcessDiagnosticSnapshot,
  interruptWrite: 'sent' | 'failed',
  termination: CodexTerminationSignals,
): void {
  logger.info('[codex-app-server] watchdog generation recycle completed', build(context, {
    outcome: 'completed',
    actualGeneration: after.processGeneration,
    processAliveAfter: after.processAlive,
    pendingRpcCountAfter: after.pendingRpcCount,
    interruptWrite,
    ...termination,
  }));
}

export function logCodexTerminationFailure(
  logger: RecycleLogger,
  context: RecycleContext,
  signal: 'SIGTERM' | 'SIGKILL',
): void {
  logger.error('[codex-app-server] retired child termination failed', build(context, {
    outcome: 'signal_failed',
    actualGeneration: context.before.processGeneration + 1,
    processAliveAfter: true,
    pendingRpcCountAfter: 0,
    signal,
  }));
}

function build(
  context: RecycleContext,
  overrides: Partial<CodexRecycleDiagnosticInput> & Pick<CodexRecycleDiagnosticInput, 'outcome'>,
): Record<string, string | number | boolean | null> {
  return buildCodexRecycleDiagnostic({
    threadId: context.threadId,
    turnId: context.turnId,
    expectedGeneration: context.expectedGeneration,
    actualGeneration: context.before.processGeneration,
    processPid: context.before.processPid,
    processAliveBefore: context.before.processAlive,
    processAliveAfter: context.before.processAlive,
    pendingRpcCountBefore: context.before.pendingRpcCount,
    pendingRpcCountAfter: context.before.pendingRpcCount,
    interruptWrite: 'not_attempted',
    sigtermSent: false,
    sigkillScheduled: false,
    stderrTailBytes: context.before.stderrTailBytes,
    hasStderrTail: context.before.hasStderrTail,
    ...overrides,
  });
}
