const MAX_STDERR_TAIL_CHARS = 1_024;
const MAX_STDERR_LINES = 8;
const MAX_IDENTIFIER_CHARS = 160;
const MAX_METHOD_CHARS = 120;

export interface CodexProcessDiagnosticSnapshot {
  processGeneration: number;
  processPid: number | null;
  processAlive: boolean;
  pendingRpcCount: number;
  stderrTailBytes: number;
  hasStderrTail: boolean;
}

export interface CodexTurnWatchdogDiagnosticInput {
  phase: 'armed' | 'first_model_event' | 'timeout';
  threadId: string;
  turnId: string;
  acceptanceSource: 'notification' | 'response';
  acceptedAtMs: number;
  deadlineAtMs: number;
  nowMs: number;
  responsePending: boolean;
  notificationCount: number;
  lastScopedNotificationMethod: string | null;
  lastScopedNotificationAtMs: number | null;
  process: CodexProcessDiagnosticSnapshot;
}

export interface CodexRecycleDiagnosticInput {
  threadId: string;
  turnId: string;
  outcome: 'completed' | 'generation_mismatch' | 'process_missing' | 'detach_failed' | 'signal_failed';
  expectedGeneration: number;
  actualGeneration: number;
  processPid: number | null;
  processAliveBefore: boolean;
  processAliveAfter: boolean;
  pendingRpcCountBefore: number;
  pendingRpcCountAfter: number;
  interruptWrite: 'sent' | 'failed' | 'not_attempted';
  sigtermSent: boolean;
  sigkillScheduled: boolean;
  signal?: 'SIGTERM' | 'SIGKILL' | null;
  stderrTailBytes: number;
  hasStderrTail: boolean;
}

/** Build an allowlisted diagnostic object. No prompt, notification payload, env, or tool data. */
export function buildCodexTurnWatchdogDiagnostic(
  input: CodexTurnWatchdogDiagnosticInput,
): Record<string, string | number | boolean | null> {
  return {
    event: 'codex_turn_watchdog',
    phase: input.phase,
    threadId: sanitizeIdentifier(input.threadId),
    turnId: sanitizeIdentifier(input.turnId),
    acceptanceSource: input.acceptanceSource,
    acceptedAtMs: finiteInteger(input.acceptedAtMs),
    deadlineAtMs: finiteInteger(input.deadlineAtMs),
    elapsedMs: nonNegativeDelta(input.nowMs, input.acceptedAtMs),
    deadlineRemainingMs: Math.max(0, nonNegativeDelta(input.deadlineAtMs, input.nowMs)),
    responsePending: input.responsePending,
    notificationCount: Math.max(0, finiteInteger(input.notificationCount)),
    lastScopedNotificationMethod: input.lastScopedNotificationMethod
      ? sanitizeMethod(input.lastScopedNotificationMethod)
      : null,
    lastScopedNotificationAgeMs: input.lastScopedNotificationAtMs === null
      ? null
      : nonNegativeDelta(input.nowMs, input.lastScopedNotificationAtMs),
    processGeneration: finiteInteger(input.process.processGeneration),
    processPid: input.process.processPid === null
      ? null
      : Math.max(0, finiteInteger(input.process.processPid)),
    processAlive: input.process.processAlive,
    pendingRpcCount: Math.max(0, finiteInteger(input.process.pendingRpcCount)),
    stderrTailBytes: Math.max(0, finiteInteger(input.process.stderrTailBytes)),
    hasStderrTail: input.process.hasStderrTail,
  };
}

export function buildCodexRecycleDiagnostic(
  input: CodexRecycleDiagnosticInput,
): Record<string, string | number | boolean | null> {
  return {
    event: 'codex_turn_watchdog_recycle',
    outcome: input.outcome,
    threadId: sanitizeIdentifier(input.threadId),
    turnId: sanitizeIdentifier(input.turnId),
    expectedGeneration: finiteInteger(input.expectedGeneration),
    actualGeneration: finiteInteger(input.actualGeneration),
    processPid: input.processPid === null ? null : Math.max(0, finiteInteger(input.processPid)),
    processAliveBefore: input.processAliveBefore,
    processAliveAfter: input.processAliveAfter,
    pendingRpcCountBefore: Math.max(0, finiteInteger(input.pendingRpcCountBefore)),
    pendingRpcCountAfter: Math.max(0, finiteInteger(input.pendingRpcCountAfter)),
    interruptWrite: input.interruptWrite,
    sigtermSent: input.sigtermSent,
    sigkillScheduled: input.sigkillScheduled,
    signal: input.signal ?? null,
    stderrTailBytes: Math.max(0, finiteInteger(input.stderrTailBytes)),
    hasStderrTail: input.hasStderrTail,
  };
}

/**
 * Keep stderr only when it has an operational tracing prefix. Drop payload-bearing lines entirely,
 * then redact credentials, URLs, paths, quoted values, and high-entropy identifiers.
 */
export function sanitizeCodexStderrTail(raw: string): string | null {
  if (!raw.trim()) return null;
  const safeLines = stripAnsi(raw)
    .split(/\r?\n/)
    .slice(-MAX_STDERR_LINES * 2)
    .flatMap((candidate) => {
      const line = candidate.replace(/\s+/g, ' ').trim();
      if (!line || !hasSafeOperationalPrefix(line)) return [];
      if (/\b(?:prompt|input|arguments?|payload|environment|env)\s*[:=]/i.test(line)) return [];
      const redacted = line
        .replace(/Bearer\s+[^\s,;)]+/gi, 'Bearer [redacted]')
        .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]')
        .replace(/\b(?:authorization|cookie|token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi,
          (match) => `${match.slice(0, match.search(/[:=]/) + 1)}[redacted]`)
        .replace(/https?:\/\/\S+/gi, '[url redacted]')
        .replace(/\/(?:Users|home|tmp|private|var)\/\S+/g, '[path redacted]')
        .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '[quoted redacted]')
        .replace(/\b[A-Za-z0-9_+/=-]{24,}\b/g, '[opaque redacted]');
      return redacted ? [redacted] : [];
    })
    .slice(-MAX_STDERR_LINES);
  if (safeLines.length === 0) return null;
  return safeLines.join('\n').slice(-MAX_STDERR_TAIL_CHARS);
}

function sanitizeIdentifier(value: string): string {
  if (!value || !/^[A-Za-z0-9:._-]+$/.test(value)) return '[invalid]';
  return value.slice(0, MAX_IDENTIFIER_CHARS);
}

function sanitizeMethod(value: string): string {
  if (!value || !/^[A-Za-z0-9:._/-]+$/.test(value)) return '[invalid]';
  return value.slice(0, MAX_METHOD_CHARS);
}

function finiteInteger(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function nonNegativeDelta(later: number, earlier: number): number {
  return Math.max(0, finiteInteger(later) - finiteInteger(earlier));
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function hasSafeOperationalPrefix(value: string): boolean {
  return /^(?:\d{4}-\d{2}-\d{2}[T ][^ ]+\s+)?(?:ERROR|WARN|INFO|DEBUG|TRACE)\s+(?:codex[\w:.-]*|app-server|transport|rpc|stream)\b/i.test(value);
}
