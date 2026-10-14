import { runtimeDiagnosticFields, runtimeDiagnosticRef } from './diagnostic-fields';

const knownEvents: Record<string, string> = {
  'Claude input acceptance delayed': 'claude-input-acceptance-delayed',
  'Provider adapter initialization failed': 'provider-initialization-failed',
  'Provider Grok container boundary is unavailable': 'provider-container-unavailable',
  'Server Core session lifecycle phase failed': 'session-lifecycle-failed',
  'Core change publication failed': 'change-publication-failed',
  'Server Core background event publication failed': 'background-publication-failed',
  'Server Core token usage persistence failed': 'token-usage-persistence-failed',
  'Server Core context usage persistence failed': 'context-usage-persistence-failed',
  'Server Core context compaction persistence failed': 'context-compaction-persistence-failed',
  'Server Core session rename metadata repair failed': 'session-rename-repair-failed',
  'Server Core session lifecycle warning': 'session-lifecycle-warning',
  'credential file became unavailable': 'credential-file-unavailable',
  'provider startup rollback was incomplete': 'provider-startup-rollback-incomplete',
  'relay-worker-attached': 'relay-worker-attached',
  'relay-worker-detached': 'relay-worker-detached',
  'relay-worker-expired': 'relay-worker-expired',
  'relay-stream-failed': 'relay-stream-failed',
  'ssh-heartbeat-timeout': 'ssh-heartbeat-timeout',
};

interface DiagnosticSink {
  write(line: string): void;
  now(): number;
}
interface Episode { at: number; suppressed: number; maxDurationMs: number; }
const scopes = new Set([
  'claude-input', 'claude-stream', 'claude-lifecycle', 'claude-runtime-metadata',
  'claude-sdk-query', 'claude-code', 'codex-app-server', 'codex-cli', 'grok-build',
]);

let stderrGuardInstalled = false;

/** Timestamped, content-free, bounded diagnostics shared by headless hosts. */
export function createRuntimeDiagnostics(overrides: Partial<DiagnosticSink> = {}) {
  if (!overrides.write && !stderrGuardInstalled) {
    process.stderr.on('error', () => undefined);
    stderrGuardInstalled = true;
  }
  const sink: DiagnosticSink = {
    now: Date.now,
    write: (line) => { process.stderr.write(line); },
    ...overrides,
  };
  const episodes = new Map<string, Episode>();
  let droppedCount = 0;
  const emit = (level: 'info' | 'warn', message: string, details?: unknown, error?: unknown): void => {
    try {
      if (!overrides.write && process.stderr.writableNeedDrain) {
        droppedCount = Math.min(9999, droppedCount + 1);
        return;
      }
      const now = sink.now();
      const bare = message.replace(/^\[[a-z0-9-]{1,64}\]\s*/, '');
      const candidateScope = /^\[([^\]]+)\]/.exec(message)?.[1];
      const scope = candidateScope && scopes.has(candidateScope) ? candidateScope : 'runtime';
      const event = Object.hasOwn(knownEvents, bare) ? knownEvents[bare]! : 'runtime-diagnostic';
      // Unknown messages may contain provider text. Retain only a run-scoped fingerprint.
      const diagnosticRef = runtimeDiagnosticRef(message.slice(0, 4096));
      const fields = runtimeDiagnosticFields(details, error);
      const key = JSON.stringify([level, diagnosticRef, fields.sessionRef, fields.connectionRef,
        fields.streamRef, fields.profileRef, fields.reason, fields.code, fields.errorName,
        fields.errorCode, fields.phase, fields.adapterId]);
      const duration = typeof fields.durationMs === 'number' ? fields.durationMs : 0;
      const previous = episodes.get(key);
      if (previous && now >= previous.at && now - previous.at < 60_000) {
        previous.suppressed = Math.min(9999, previous.suppressed + 1);
        previous.maxDurationMs = Math.max(previous.maxDurationMs, duration);
        return;
      }
      if (!previous && episodes.size >= 256) episodes.delete(episodes.keys().next().value!);
      episodes.delete(key);
      episodes.set(key, { at: now, suppressed: 0, maxDurationMs: duration });
      sink.write(`${JSON.stringify({
        timestamp: new Date(now).toISOString(), level, scope, event, diagnosticRef, ...fields,
        ...(previous?.suppressed ? {
          suppressedCount: previous.suppressed,
          maxDurationMs: Math.max(previous.maxDurationMs, duration),
        } : {}),
        ...(droppedCount ? { droppedCount } : {}),
      })}\n`);
      droppedCount = 0;
    } catch {
      // A closed diagnostic pipe, bad clock, or serializer cannot fail the host operation.
    }
  };
  return Object.freeze({
    info: (message: string, details?: unknown) => emit('info', message, details),
    warn: (message: string, details?: unknown, error?: unknown) => emit('warn', message, details, error),
  });
}
