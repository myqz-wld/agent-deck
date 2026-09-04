import { performance } from 'node:perf_hooks';
import {
  BoundedLogStateTracker,
  type LogStateDecision,
  type LogStateSnapshot,
} from '@main/utils/log-state-tracker';
import log from '@main/utils/logger';
import { getProcessRunId } from '@main/utils/run-context';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';

const logger = log.scope('agent-deck-mcp-http');

export const MCP_HTTP_OBSERVER_CAPACITY = 64;
export const MCP_HTTP_SUMMARY_INTERVAL_MS = 5 * 60_000;
export const MCP_HTTP_LOCAL_SLOW_THRESHOLD_MS = 2_000;
export const MCP_HTTP_LIFECYCLE_SLOW_THRESHOLD_MS = 30_000;
export const MCP_HTTP_SPAWN_SLOW_THRESHOLD_MS = 60_000;
export const MCP_HTTP_HANDOFF_SLOW_THRESHOLD_MS = 180_000;

const MAX_NUMERIC_VALUE = Number.MAX_SAFE_INTEGER;
const MAX_OPERATION_NAME_LENGTH = 64;

export type McpHttpOperationClass =
  | 'human_wait'
  | 'spawn'
  | 'hand_off'
  | 'lifecycle'
  | 'local'
  | 'protocol'
  | 'unknown';

type McpHttpDiagnosticState =
  | 'healthy'
  | 'slow'
  | 'client_aborted'
  | 'http_4xx'
  | 'http_5xx';

type McpHttpStatusClass = 'success' | '4xx' | '5xx' | 'none';

export interface McpHttpOperation {
  operationClass: McpHttpOperationClass;
  /** Fixed numeric signature assigned only by the allowlisted classifier. */
  correlationSlot: number;
}

export interface McpHttpObservation {
  operation: McpHttpOperation;
  startedAtMs: number | null;
}

export type McpHttpCompletion =
  | { kind: 'response'; statusCode: unknown }
  | { kind: 'client_aborted' };

export interface McpHttpObserver {
  begin(body: unknown): McpHttpObservation;
  beginOperation(operation: McpHttpOperation): McpHttpObservation;
  complete(
    observation: McpHttpObservation | null,
    completion: McpHttpCompletion,
  ): void;
}

const operation = (
  operationClass: McpHttpOperationClass,
  correlationSlot: number,
): McpHttpOperation => Object.freeze({ operationClass, correlationSlot });

const TOOL_OPERATIONS = new Map<string, McpHttpOperation>([
  ['present_plan', operation('human_wait', 0)],
  ['present_diff', operation('human_wait', 1)],
  ['spawn_session', operation('spawn', 3)],
  ['hand_off_session', operation('hand_off', 4)],
  ['enter_worktree', operation('lifecycle', 5)],
  ['exit_worktree', operation('lifecycle', 6)],
  ['shutdown_session', operation('lifecycle', 7)],
  ['send_message', operation('local', 10)],
  ['list_sessions', operation('local', 11)],
  ['get_session', operation('local', 12)],
  ['list_session_events', operation('local', 13)],
  ['task_create', operation('local', 14)],
  ['task_list', operation('local', 15)],
  ['task_get', operation('local', 16)],
  ['task_update', operation('local', 17)],
  ['task_delete', operation('local', 18)],
  ['report_issue', operation('local', 19)],
  ['append_issue_context', operation('local', 20)],
  ['update_issue_status', operation('local', 21)],
]);

const PROTOCOL_OPERATIONS = new Map<string, McpHttpOperation>([
  ['initialize', operation('protocol', 48)],
  ['notifications/initialized', operation('protocol', 49)],
  ['notifications/cancelled', operation('protocol', 50)],
  ['ping', operation('protocol', 51)],
  ['tools/list', operation('protocol', 52)],
]);

const BATCH_OPERATION = operation('protocol', 53);
const GET_OPERATION = operation('protocol', 60);
const DELETE_OPERATION = operation('protocol', 61);
const UNKNOWN_OPERATION = operation('unknown', 63);

/** Classify a parsed MCP request without retaining arguments or unrecognized strings. */
export function classifyMcpHttpOperation(body: unknown): McpHttpOperation {
  try {
    if (Array.isArray(body)) return BATCH_OPERATION;
    const record = asRecord(body);
    if (!record) return UNKNOWN_OPERATION;
    const method = readStringField(record, 'method');
    if (!method) return UNKNOWN_OPERATION;
    if (method === 'tools/call') {
      const params = asRecord(readField(record, 'params'));
      const toolName = params ? readStringField(params, 'name') : null;
      return toolName
        ? TOOL_OPERATIONS.get(toolName) ?? UNKNOWN_OPERATION
        : UNKNOWN_OPERATION;
    }
    return PROTOCOL_OPERATIONS.get(method) ?? UNKNOWN_OPERATION;
  } catch {
    return UNKNOWN_OPERATION;
  }
}

/** Fixed signatures for the stateless GET/DELETE 405 handlers. */
export function classifyMcpHttpMethod(
  method: 'GET' | 'DELETE',
): McpHttpOperation {
  return method === 'GET' ? GET_OPERATION : DELETE_OPERATION;
}

export function mcpHttpSlowThresholdMs(
  operationClass: McpHttpOperationClass,
): number | null {
  switch (operationClass) {
    case 'human_wait':
      return null;
    case 'spawn':
      return MCP_HTTP_SPAWN_SLOW_THRESHOLD_MS;
    case 'hand_off':
      return MCP_HTTP_HANDOFF_SLOW_THRESHOLD_MS;
    case 'lifecycle':
      return MCP_HTTP_LIFECYCLE_SLOW_THRESHOLD_MS;
    case 'local':
    case 'protocol':
    case 'unknown':
      return MCP_HTTP_LOCAL_SLOW_THRESHOLD_MS;
  }
}

/**
 * Bounded, content-free state transitions for MCP HTTP completions. Raw request and caller data
 * never enter tracker keys or emitted payloads.
 */
export class McpHttpTransportObserver implements McpHttpObserver {
  private readonly tracker = new BoundedLogStateTracker<
    string,
    McpHttpDiagnosticState
  >({
    capacity: MCP_HTTP_OBSERVER_CAPACITY,
    summaryIntervalMs: MCP_HTTP_SUMMARY_INTERVAL_MS,
    now: () => this.clockMs,
  });
  private lastClockMs: number | null = null;
  private clockMs = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  begin(body: unknown): McpHttpObservation {
    try {
      return this.beginOperation(classifyMcpHttpOperation(body));
    } catch {
      return { operation: UNKNOWN_OPERATION, startedAtMs: null };
    }
  }

  beginOperation(input: McpHttpOperation): McpHttpObservation {
    try {
      const normalized = normalizeOperation(input) ?? UNKNOWN_OPERATION;
      return {
        operation: normalized,
        startedAtMs:
          mcpHttpSlowThresholdMs(normalized.operationClass) === null
            ? null
            : this.readClock(),
      };
    } catch {
      return { operation: UNKNOWN_OPERATION, startedAtMs: null };
    }
  }

  complete(
    observation: McpHttpObservation | null,
    completion: McpHttpCompletion,
  ): void {
    try {
      if (!observation) return;
      const current = this.readClock();
      if (current === null) return;
      const operation = normalizeOperation(observation.operation);
      if (!operation) return;
      const durationMs = measuredDuration(observation.startedAtMs, current);
      const classified = classifyCompletion(
        completion,
        durationMs,
        mcpHttpSlowThresholdMs(operation.operationClass),
      );
      if (!classified) return;
      const key = `${operation.operationClass}:${operation.correlationSlot}`;
      let decision: LogStateDecision<McpHttpDiagnosticState>;
      try {
        decision = this.tracker.observe(key, {
          signature: classified.state,
          abnormal: classified.state !== 'healthy',
          metric: durationMs,
        });
      } catch {
        try {
          this.tracker.forget(key);
        } catch {
          // Diagnostics are best-effort.
        }
        return;
      }
      emitDecision(
        decision,
        operation.operationClass,
        classified.statusClass,
        durationMs,
      );
    } catch {
      // Diagnostics cannot affect HTTP responses, streams, aborts, or cleanup.
    }
  }

  reset(): void {
    try {
      this.tracker.clear();
      this.lastClockMs = null;
      this.clockMs = 0;
    } catch {
      // Diagnostics are best-effort.
    }
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
      this.tracker.clear();
      this.lastClockMs = bounded;
      this.clockMs = bounded;
      return null;
    }
    this.lastClockMs = bounded;
    this.clockMs = bounded;
    return bounded;
  }
}

export const mcpHttpTransportObserver = new McpHttpTransportObserver();

function classifyCompletion(
  completion: McpHttpCompletion,
  durationMs: number | null,
  slowThresholdMs: number | null,
): {
  state: McpHttpDiagnosticState;
  statusClass: McpHttpStatusClass;
} | null {
  if (completion.kind === 'client_aborted') {
    return { state: 'client_aborted', statusClass: 'none' };
  }
  const statusCode = normalizedStatusCode(completion.statusCode);
  if (statusCode === null) return null;
  if (statusCode >= 500) {
    return { state: 'http_5xx', statusClass: '5xx' };
  }
  if (statusCode >= 400) {
    return { state: 'http_4xx', statusClass: '4xx' };
  }
  if (
    slowThresholdMs !== null &&
    durationMs !== null &&
    durationMs >= slowThresholdMs
  ) {
    return { state: 'slow', statusClass: 'success' };
  }
  return { state: 'healthy', statusClass: 'success' };
}

function emitDecision(
  decision: LogStateDecision<McpHttpDiagnosticState>,
  operationClass: McpHttpOperationClass,
  statusClass: McpHttpStatusClass,
  durationMs: number | null,
): void {
  if (decision.kind === 'repeat') return;
  if (decision.kind === 'initial' && !decision.current.abnormal) return;

  const priorAbnormal: LogStateSnapshot<McpHttpDiagnosticState> | null =
    decision.flushed?.abnormal ? decision.flushed : null;
  const aggregate =
    decision.kind === 'periodic-summary'
      ? priorAbnormal ?? decision.current
      : decision.current.abnormal
        ? decision.current
        : priorAbnormal ?? decision.current;
  const suppressed = priorAbnormal ?? decision.current;

  try {
    const details = safeDiagnostic({
      event: 'agent-deck-mcp-http-state',
      runId: getProcessRunId(),
      operationClass,
      state: decision.current.signature,
      previousState: decision.flushed?.signature ?? null,
      transition: decision.kind,
      durationMs,
      abnormalDurationMs: aggregate.abnormalDurationMs,
      suppressedCount: suppressed.suppressedCount,
      suppressedCountCapped: suppressed.suppressedCountCapped,
      maxDurationMs: aggregate.maxMetric,
      slowThresholdMs: mcpHttpSlowThresholdMs(operationClass),
      summaryIntervalMs: MCP_HTTP_SUMMARY_INTERVAL_MS,
      statusClass,
    });
    if (decision.current.abnormal) {
      logger.warn(
        decision.kind === 'periodic-summary'
          ? 'MCP HTTP operation state remains degraded'
          : 'MCP HTTP operation state degraded',
        details,
      );
    } else if (priorAbnormal) {
      logger.info('MCP HTTP operation state recovered', details);
    }
  } catch {
    // Diagnostic serialization and sinks cannot affect the transport.
  }
}

function normalizeOperation(value: McpHttpOperation): McpHttpOperation | null {
  if (
    !isOperationClass(value.operationClass) ||
    !Number.isSafeInteger(value.correlationSlot) ||
    value.correlationSlot < 0
  ) {
    return null;
  }
  return value;
}

function isOperationClass(value: unknown): value is McpHttpOperationClass {
  return (
    value === 'human_wait' ||
    value === 'spawn' ||
    value === 'hand_off' ||
    value === 'lifecycle' ||
    value === 'local' ||
    value === 'protocol' ||
    value === 'unknown'
  );
}

function measuredDuration(
  startedAtMs: number | null,
  current: number,
): number | null {
  if (
    startedAtMs === null ||
    !Number.isFinite(startedAtMs) ||
    startedAtMs < 0 ||
    startedAtMs > current
  ) {
    return null;
  }
  return Math.min(MAX_NUMERIC_VALUE, current - startedAtMs);
}

function normalizedStatusCode(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readField(
  record: Record<string, unknown>,
  field: 'method' | 'params' | 'name',
): unknown {
  try {
    return record[field];
  } catch {
    return undefined;
  }
}

function readStringField(
  record: Record<string, unknown>,
  field: 'method' | 'name',
): string | null {
  const value = readField(record, field);
  return typeof value === 'string' && value.length <= MAX_OPERATION_NAME_LENGTH
    ? value
    : null;
}
