import { AGENT_DECK_MCP_SERVER_NAME } from '@main/codex-config/agent-deck-mcp-injector';
import {
  BoundedLogStateTracker,
  type LogStateDecision,
  type LogStateSnapshot,
} from '@main/utils/log-state-tracker';
import { getProcessRunId } from '@main/utils/run-context';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';
import type { CodexAppServerNotification } from './protocol';

type McpStartupState = 'starting' | 'ready' | 'failed' | 'cancelled';
type McpStartupDiagnosticState = 'ready' | 'slow' | 'failed' | 'cancelled';
type ThreadCorrelationKey = string | typeof UNSCOPED_THREAD;

interface ThreadStartupEntry {
  startedAtMs: number | null;
  tracker: BoundedLogStateTracker<'startup', McpStartupDiagnosticState>;
}

export interface McpStartupLogEvent {
  level: 'info' | 'warn';
  message: string;
}

const MAX_THREAD_ENTRIES = 128;
const SLOW_STARTUP_THRESHOLD_MS = 10_000;
const ABNORMAL_SUMMARY_INTERVAL_MS = 5 * 60_000;
const MAX_MESSAGE_LENGTH = 512;
const MAX_NUMERIC_VALUE = Number.MAX_SAFE_INTEGER;
const UNSCOPED_THREAD = Symbol('unscoped-agent-deck-mcp-startup');

/**
 * Observes only Agent Deck MCP startup notifications. Raw thread IDs are bounded internal
 * correlation keys and never enter returned diagnostics.
 */
export class AgentDeckMcpStartupObserver {
  private readonly entries = new Map<ThreadCorrelationKey, ThreadStartupEntry>();
  private lastClockMs: number | null = null;
  private clockMs = 0;

  constructor(private readonly now: () => number = Date.now) {}

  observe(notification: CodexAppServerNotification): McpStartupLogEvent | null {
    try {
      if (notification.method !== 'mcpServer/startupStatus/updated') return null;
      const params = asRecord(notification.params);
      if (!params || params.name !== AGENT_DECK_MCP_SERVER_NAME) return null;

      const status = readStartupState(params.status);
      if (!status) return null;
      const current = this.readClock();
      if (current === null) return null;

      const threadKey =
        typeof params.threadId === 'string' ? params.threadId : UNSCOPED_THREAD;
      const entry = this.getOrCreateEntry(threadKey);
      if (status === 'starting') {
        if (entry.startedAtMs === null) entry.startedAtMs = current;
        return null;
      }

      const durationMs = measuredDuration(entry.startedAtMs, current);
      entry.startedAtMs = null;
      const state = diagnosticState(status, durationMs);
      let decision: LogStateDecision<McpStartupDiagnosticState>;
      try {
        decision = entry.tracker.observe('startup', {
          signature: state,
          abnormal: state !== 'ready',
          metric: durationMs,
        });
      } catch {
        this.entries.delete(threadKey);
        return null;
      }
      return encodeDecision(decision, durationMs);
    } catch {
      return null;
    }
  }

  reset(): void {
    this.entries.clear();
    this.lastClockMs = null;
    this.clockMs = 0;
  }

  private readClock(): number | null {
    let candidate: number;
    try {
      candidate = this.now();
    } catch {
      return null;
    }
    if (!Number.isFinite(candidate)) return null;
    const bounded = Math.min(MAX_NUMERIC_VALUE, Math.max(0, candidate));
    if (this.lastClockMs !== null && bounded < this.lastClockMs) {
      this.entries.clear();
      this.lastClockMs = bounded;
      this.clockMs = bounded;
      return null;
    }
    this.lastClockMs = bounded;
    this.clockMs = bounded;
    return bounded;
  }

  private getOrCreateEntry(threadKey: ThreadCorrelationKey): ThreadStartupEntry {
    const existing = this.entries.get(threadKey);
    if (existing) {
      this.entries.delete(threadKey);
      this.entries.set(threadKey, existing);
      return existing;
    }
    if (this.entries.size >= MAX_THREAD_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    const entry: ThreadStartupEntry = {
      startedAtMs: null,
      tracker: new BoundedLogStateTracker({
        capacity: 1,
        summaryIntervalMs: ABNORMAL_SUMMARY_INTERVAL_MS,
        now: () => this.clockMs,
      }),
    };
    this.entries.set(threadKey, entry);
    return entry;
  }
}

function diagnosticState(
  status: Exclude<McpStartupState, 'starting'>,
  durationMs: number | null,
): McpStartupDiagnosticState {
  if (status !== 'ready') return status;
  return durationMs !== null && durationMs >= SLOW_STARTUP_THRESHOLD_MS
    ? 'slow'
    : 'ready';
}

function measuredDuration(startedAtMs: number | null, current: number): number | null {
  if (startedAtMs === null) return null;
  const elapsed = current - startedAtMs;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return null;
  return Math.min(MAX_NUMERIC_VALUE, elapsed);
}

function encodeDecision(
  decision: LogStateDecision<McpStartupDiagnosticState>,
  durationMs: number | null,
): McpStartupLogEvent | null {
  if (decision.kind === 'repeat') return null;
  if (decision.kind === 'initial' && !decision.current.abnormal) return null;

  const priorAbnormal: LogStateSnapshot<McpStartupDiagnosticState> | null =
    decision.flushed?.abnormal ? decision.flushed : null;
  const aggregate =
    decision.kind === 'periodic-summary'
      ? priorAbnormal ?? decision.current
      : decision.current.abnormal
        ? decision.current
        : priorAbnormal ?? decision.current;
  const suppressed = priorAbnormal ?? decision.current;
  const level: McpStartupLogEvent['level'] | null =
    decision.current.abnormal
      ? 'warn'
      : priorAbnormal
        ? 'info'
        : null;
  if (!level) return null;

  try {
    const message = JSON.stringify(safeDiagnostic({
      event: 'agent-deck-mcp-startup-state',
      runId: getProcessRunId(),
      state: decision.current.signature,
      previousState: decision.flushed?.signature ?? null,
      transition: decision.kind,
      durationMs,
      abnormalDurationMs: aggregate.abnormalDurationMs,
      suppressedCount: suppressed.suppressedCount,
      suppressedCountCapped: suppressed.suppressedCountCapped,
      maxDurationMs: aggregate.maxMetric,
      slowThresholdMs: SLOW_STARTUP_THRESHOLD_MS,
      summaryIntervalMs: ABNORMAL_SUMMARY_INTERVAL_MS,
    }));
    if (!message || message.length > MAX_MESSAGE_LENGTH) return null;
    return { level, message };
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readStartupState(value: unknown): McpStartupState | null {
  return value === 'starting' ||
    value === 'ready' ||
    value === 'failed' ||
    value === 'cancelled'
    ? value
    : null;
}
