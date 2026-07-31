import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  diagnosticMode: 'normal' as 'normal' | 'throw',
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@main/utils/logger', () => ({
  default: {
    ...mocks.logger,
    scope: () => mocks.logger,
  },
}));
vi.mock('@main/utils/run-context', () => ({
  getProcessRunId: () => 'mcp-http-test-run',
}));
vi.mock('@main/utils/safe-diagnostic', () => ({
  safeDiagnostic: (value: unknown) => {
    if (mocks.diagnosticMode === 'throw') {
      throw new Error('serializer secret');
    }
    return value;
  },
}));

import {
  MCP_HTTP_HANDOFF_SLOW_THRESHOLD_MS,
  MCP_HTTP_LIFECYCLE_SLOW_THRESHOLD_MS,
  MCP_HTTP_LOCAL_SLOW_THRESHOLD_MS,
  MCP_HTTP_OBSERVER_CAPACITY,
  MCP_HTTP_SPAWN_SLOW_THRESHOLD_MS,
  MCP_HTTP_SUMMARY_INTERVAL_MS,
  McpHttpTransportObserver,
  classifyMcpHttpOperation,
  mcpHttpSlowThresholdMs,
  type McpHttpOperation,
  type McpHttpObservation,
} from '../transport-http-observability';

function diagnostic(
  level: 'info' | 'warn',
  index = 0,
): Record<string, unknown> {
  return mocks.logger[level].mock.calls[index]?.[1] as Record<string, unknown>;
}

function toolBody(name: string, secret = 'private input'): unknown {
  return {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name, arguments: { prompt: secret } },
  };
}

function syntheticObservation(
  correlationSlot: number,
  operationClass: McpHttpOperation['operationClass'] = 'local',
): McpHttpObservation {
  return {
    operation: { operationClass, correlationSlot },
    startedAtMs: null,
  };
}

beforeEach(() => {
  mocks.diagnosticMode = 'normal';
  for (const method of Object.values(mocks.logger)) method.mockReset();
});

describe('MCP HTTP operation classifier', () => {
  it('uses only the frozen operation classes and threshold table', () => {
    expect(classifyMcpHttpOperation(toolBody('present_plan'))).toMatchObject({
      operationClass: 'human_wait',
    });
    expect(classifyMcpHttpOperation(toolBody('present_diff'))).toMatchObject({
      operationClass: 'human_wait',
    });
    expect(classifyMcpHttpOperation(toolBody('browser_wait'))).toMatchObject({
      operationClass: 'human_wait',
    });
    expect(classifyMcpHttpOperation(toolBody('spawn_session'))).toMatchObject({
      operationClass: 'spawn',
    });
    expect(classifyMcpHttpOperation(toolBody('hand_off_session'))).toMatchObject({
      operationClass: 'hand_off',
    });
    for (const name of [
      'enter_worktree',
      'exit_worktree',
      'shutdown_session',
    ]) {
      expect(classifyMcpHttpOperation(toolBody(name))).toMatchObject({
        operationClass: 'lifecycle',
      });
    }
    for (const name of [
      'send_message',
      'list_sessions',
      'get_session',
      'list_session_events',
      'task_create',
      'task_list',
      'task_get',
      'task_update',
      'task_delete',
      'report_issue',
      'append_issue_context',
      'update_issue_status',
      'browser_open',
      'browser_tabs',
      'browser_navigate',
      'browser_close',
      'browser_snapshot',
      'browser_screenshot',
      'browser_click',
      'browser_type',
      'browser_press',
      'browser_scroll',
      'browser_read_console',
      'browser_read_network',
      'browser_evaluate',
    ]) {
      expect(classifyMcpHttpOperation(toolBody(name))).toMatchObject({
        operationClass: 'local',
      });
    }
    expect(classifyMcpHttpOperation({ method: 'initialize' })).toMatchObject({
      operationClass: 'protocol',
    });
    expect(classifyMcpHttpOperation([])).toMatchObject({
      operationClass: 'protocol',
    });

    expect(mcpHttpSlowThresholdMs('human_wait')).toBeNull();
    expect(mcpHttpSlowThresholdMs('spawn')).toBe(
      MCP_HTTP_SPAWN_SLOW_THRESHOLD_MS,
    );
    expect(mcpHttpSlowThresholdMs('hand_off')).toBe(
      MCP_HTTP_HANDOFF_SLOW_THRESHOLD_MS,
    );
    expect(mcpHttpSlowThresholdMs('lifecycle')).toBe(
      MCP_HTTP_LIFECYCLE_SLOW_THRESHOLD_MS,
    );
    for (const operationClass of ['local', 'protocol', 'unknown'] as const) {
      expect(mcpHttpSlowThresholdMs(operationClass)).toBe(
        MCP_HTTP_LOCAL_SLOW_THRESHOLD_MS,
      );
    }
  });

  it('collapses arbitrary and hostile request accessors to unknown', () => {
    const hostileMethod = Object.defineProperty({}, 'method', {
      get: () => {
        throw new Error('method getter https://secret.test/?token=raw');
      },
    });
    const hostileTool = {
      method: 'tools/call',
      params: Object.defineProperty({}, 'name', {
        get: () => {
          throw new Error('tool getter /Users/private');
        },
      }),
    };

    for (const body of [
      hostileMethod,
      hostileTool,
      toolBody('hostile_tool https://secret.test/?token=raw'),
      { method: 'hostile/rpc /Users/private' },
      { method: 'x'.repeat(10_000) },
      'not an object',
    ]) {
      expect(classifyMcpHttpOperation(body)).toMatchObject({
        operationClass: 'unknown',
      });
    }
  });
});

describe('McpHttpTransportObserver', () => {
  it('warns at each exact slow threshold and recovers once', () => {
    const cases = [
      ['send_message', MCP_HTTP_LOCAL_SLOW_THRESHOLD_MS],
      ['spawn_session', MCP_HTTP_SPAWN_SLOW_THRESHOLD_MS],
      ['hand_off_session', MCP_HTTP_HANDOFF_SLOW_THRESHOLD_MS],
      ['enter_worktree', MCP_HTTP_LIFECYCLE_SLOW_THRESHOLD_MS],
    ] as const;

    for (const [toolName, threshold] of cases) {
      let now = 0;
      const observer = new McpHttpTransportObserver(() => now);
      const fast = observer.begin(toolBody(toolName));
      now = threshold - 1;
      observer.complete(fast, { kind: 'response', statusCode: 200 });
      expect(mocks.logger.warn).not.toHaveBeenCalled();

      now += 1_000;
      const slow = observer.begin(toolBody(toolName));
      now += threshold;
      observer.complete(slow, { kind: 'response', statusCode: 204 });
      expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
      expect(diagnostic('warn')).toMatchObject({
        event: 'agent-deck-mcp-http-state',
        runId: 'mcp-http-test-run',
        state: 'slow',
        previousState: 'healthy',
        transition: 'transition',
        durationMs: threshold,
        maxDurationMs: threshold,
        slowThresholdMs: threshold,
        statusClass: 'success',
      });
      expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(
        toolName,
      );

      now += 1;
      const recovery = observer.begin(toolBody(toolName));
      now += 1;
      observer.complete(recovery, { kind: 'response', statusCode: 200 });
      expect(mocks.logger.info).toHaveBeenCalledTimes(1);
      expect(diagnostic('info')).toMatchObject({
        state: 'healthy',
        previousState: 'slow',
        transition: 'transition',
      });

      for (const method of Object.values(mocks.logger)) method.mockReset();
    }
  });

  it('keeps human waits duration-free and recovers only from explicit failure', () => {
    let now = 0;
    const observer = new McpHttpTransportObserver(() => now);
    const initial = observer.begin(toolBody('present_plan'));
    expect(initial.startedAtMs).toBeNull();
    now = 24 * 60 * 60_000;
    observer.complete(initial, { kind: 'response', statusCode: 200 });
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();

    const aborted = observer.begin(toolBody('present_plan'));
    observer.complete(aborted, { kind: 'client_aborted' });
    expect(diagnostic('warn')).toMatchObject({
      operationClass: 'human_wait',
      state: 'client_aborted',
      durationMs: null,
      slowThresholdMs: null,
      statusClass: 'none',
    });

    const recovered = observer.begin(toolBody('present_plan'));
    now += 60 * 60_000;
    observer.complete(recovered, { kind: 'response', statusCode: 200 });
    expect(mocks.logger.info).toHaveBeenCalledOnce();
    expect(diagnostic('info')).toMatchObject({
      state: 'healthy',
      previousState: 'client_aborted',
      durationMs: null,
      slowThresholdMs: null,
    });
  });

  it('silences repeats and emits one capped five-minute summary', () => {
    let now = MCP_HTTP_LOCAL_SLOW_THRESHOLD_MS;
    const observer = new McpHttpTransportObserver(() => now);
    const operation = classifyMcpHttpOperation(toolBody('send_message'));
    const initial: McpHttpObservation = {
      operation,
      startedAtMs: 0,
    };
    observer.complete(initial, { kind: 'response', statusCode: 200 });

    for (let index = 0; index < 10_000; index += 1) {
      observer.complete(initial, { kind: 'response', statusCode: 200 });
    }
    expect(mocks.logger.warn).toHaveBeenCalledOnce();

    now += MCP_HTTP_SUMMARY_INTERVAL_MS;
    observer.complete(
      {
        operation,
        startedAtMs: now - MCP_HTTP_LOCAL_SLOW_THRESHOLD_MS * 2,
      },
      { kind: 'response', statusCode: 200 },
    );
    expect(mocks.logger.warn).toHaveBeenCalledTimes(2);
    expect(diagnostic('warn', 1)).toMatchObject({
      state: 'slow',
      previousState: 'slow',
      transition: 'periodic-summary',
      abnormalDurationMs: MCP_HTTP_SUMMARY_INTERVAL_MS,
      suppressedCount: 9_999,
      suppressedCountCapped: true,
      maxDurationMs: MCP_HTTP_LOCAL_SLOW_THRESHOLD_MS * 2,
      summaryIntervalMs: MCP_HTTP_SUMMARY_INTERVAL_MS,
    });
  });

  it('distinguishes abort, 4xx, and 5xx signature transitions without secrets', () => {
    let now = 100;
    const observer = new McpHttpTransportObserver(() => now);
    const rawTool =
      'hostile_tool /Users/private https://secret.test/?token=raw';
    const rawInput =
      'prompt secret Authorization=Bearer-raw cookie=raw session-id=raw';
    const observation = observer.begin(toolBody(rawTool, rawInput));

    observer.complete(observation, { kind: 'client_aborted' });
    now += 1;
    observer.complete(observation, { kind: 'response', statusCode: 429 });
    now += 1;
    observer.complete(observation, { kind: 'response', statusCode: 503 });

    expect(mocks.logger.warn).toHaveBeenCalledTimes(3);
    expect(diagnostic('warn', 0)).toMatchObject({
      operationClass: 'unknown',
      state: 'client_aborted',
      previousState: null,
      statusClass: 'none',
    });
    expect(diagnostic('warn', 1)).toMatchObject({
      state: 'http_4xx',
      previousState: 'client_aborted',
      statusClass: '4xx',
    });
    expect(diagnostic('warn', 2)).toMatchObject({
      state: 'http_5xx',
      previousState: 'http_4xx',
      statusClass: '5xx',
    });

    const emitted = JSON.stringify(mocks.logger.warn.mock.calls);
    for (const secret of [
      rawTool,
      '/Users/private',
      'secret.test',
      'token=raw',
      'prompt secret',
      'Bearer-raw',
      'cookie=raw',
      'session-id=raw',
      'hostile_tool',
    ]) {
      expect(emitted).not.toContain(secret);
    }
  });

  it('bounds state to 64 deterministic LRU entries and treats re-add as initial', () => {
    const observer = new McpHttpTransportObserver(() => 1_000);
    for (let slot = 0; slot < MCP_HTTP_OBSERVER_CAPACITY; slot += 1) {
      observer.complete(syntheticObservation(slot), { kind: 'client_aborted' });
    }
    expect(mocks.logger.warn).toHaveBeenCalledTimes(MCP_HTTP_OBSERVER_CAPACITY);

    observer.complete(syntheticObservation(0), { kind: 'client_aborted' });
    observer.complete(
      syntheticObservation(MCP_HTTP_OBSERVER_CAPACITY),
      { kind: 'client_aborted' },
    );
    observer.complete(syntheticObservation(1), { kind: 'client_aborted' });

    expect(mocks.logger.warn).toHaveBeenCalledTimes(
      MCP_HTTP_OBSERVER_CAPACITY + 2,
    );
    expect(
      diagnostic('warn', MCP_HTTP_OBSERVER_CAPACITY + 1),
    ).toMatchObject({
      previousState: null,
      transition: 'initial',
    });
  });

  it('contains logger, serializer, tracker, and clock failures', () => {
    let now = 0;
    let clockMode: 'normal' | 'throw' | 'nonfinite' = 'normal';
    const observer = new McpHttpTransportObserver(() => {
      if (clockMode === 'throw') throw new Error('clock secret');
      if (clockMode === 'nonfinite') return Number.NaN;
      return now;
    });

    mocks.diagnosticMode = 'throw';
    expect(() => {
      observer.complete(syntheticObservation(0), {
        kind: 'client_aborted',
      });
    }).not.toThrow();

    observer.reset();
    mocks.diagnosticMode = 'normal';
    mocks.logger.warn.mockImplementationOnce(() => {
      throw new Error('logger secret');
    });
    expect(() => {
      observer.complete(syntheticObservation(0), {
        kind: 'client_aborted',
      });
    }).not.toThrow();

    observer.reset();
    const tracker = (
      observer as unknown as {
        tracker: { observe: (...args: unknown[]) => unknown };
      }
    ).tracker;
    const originalObserve = tracker.observe.bind(tracker);
    tracker.observe = () => {
      throw new Error('tracker secret');
    };
    expect(() => {
      observer.complete(syntheticObservation(0), {
        kind: 'client_aborted',
      });
    }).not.toThrow();
    tracker.observe = originalObserve;

    for (const mode of ['throw', 'nonfinite'] as const) {
      clockMode = mode;
      expect(() => observer.begin(toolBody('send_message'))).not.toThrow();
      expect(() => {
        observer.complete(syntheticObservation(0), {
          kind: 'client_aborted',
        });
      }).not.toThrow();
    }

    clockMode = 'normal';
    const hostileCompletion = Object.defineProperty(
      { kind: 'response' },
      'statusCode',
      {
        get: () => {
          throw new Error('status accessor secret');
        },
      },
    );
    expect(() => {
      observer.complete(
        syntheticObservation(2),
        hostileCompletion as { kind: 'response'; statusCode: unknown },
      );
    }).not.toThrow();

    now = 100;
    observer.reset();
    observer.complete(syntheticObservation(0), { kind: 'client_aborted' });
    now = 50;
    observer.complete(syntheticObservation(0), {
      kind: 'response',
      statusCode: 200,
    });
    now = 60;
    observer.complete(syntheticObservation(0), {
      kind: 'response',
      statusCode: 200,
    });
    expect(mocks.logger.info).not.toHaveBeenCalled();
  });
});
