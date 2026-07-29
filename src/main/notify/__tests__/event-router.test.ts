import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    logger,
    loggerScope: vi.fn(() => logger),
    safeDiagnostic: vi.fn((value: unknown) => value),
    getProcessRunId: vi.fn(() => 'event-router-test-run'),
    sessionGet: vi.fn(),
    notifyUser: vi.fn(),
  };
});

vi.mock('@main/utils/logger', () => ({
  default: {
    scope: mocks.loggerScope,
  },
}));

vi.mock('@main/utils/safe-diagnostic', () => ({
  safeDiagnostic: mocks.safeDiagnostic,
}));

vi.mock('@main/utils/run-context', () => ({
  getProcessRunId: mocks.getProcessRunId,
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    get: mocks.sessionGet,
  },
}));

vi.mock('@main/notify/visual', () => ({
  notifyUser: mocks.notifyUser,
}));

async function route(event: unknown): Promise<void> {
  const { routeEventToNotification } = await import('../event-router');
  routeEventToNotification(event as never);
}

function waitingEvent(type = 'permission', message = 'Approve this action') {
  return {
    kind: 'waiting-for-user',
    sessionId: 'raw-private-session-id',
    payload: { type, message },
  };
}

function finishedEvent(ok: boolean, subtype?: string) {
  return {
    kind: 'finished',
    sessionId: 'raw-private-session-id',
    payload: { ok, subtype },
  };
}

function loggedText(): string {
  return [
    ...mocks.logger.info.mock.calls,
    ...mocks.logger.warn.mock.calls,
    ...mocks.logger.error.mock.calls,
  ].flat().map(String).join(' ');
}

describe('notification event router observability', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mocks.loggerScope.mockReturnValue(mocks.logger);
    mocks.safeDiagnostic.mockImplementation((value: unknown) => value);
    mocks.getProcessRunId.mockReturnValue('event-router-test-run');
    mocks.sessionGet.mockReturnValue({ title: 'Private session title' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reports notification failure without persisting raw event or error content', async () => {
    mocks.notifyUser.mockImplementation(() => {
      throw new Error(
        'RAW_NOTIFICATION_MARKER token=private /Users/private/repo https://private.test',
      );
    });

    await route(waitingEvent('permission', 'raw private prompt body'));

    expect(loggedText()).not.toMatch(
      /RAW_|private-token|private-session|\/Users\/private|https:\/\//,
    );
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'notification routing degraded',
      {
        event: 'notification-routing-state',
        runId: 'event-router-test-run',
        operation: 'waiting-for-user',
        state: 'notification-failed',
        previousState: null,
        transition: 'initial',
        abnormalDurationMs: 0,
        suppressedCount: 0,
        suppressedCountCapped: false,
        summaryIntervalMs: 300_000,
      },
    );
    const diagnostic = mocks.logger.warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(diagnostic).sort()).toEqual([
      'abnormalDurationMs',
      'event',
      'operation',
      'previousState',
      'runId',
      'state',
      'summaryIntervalMs',
      'suppressedCount',
      'suppressedCountCapped',
      'transition',
    ].sort());
  });

  it('preserves waiting notification content and filters cancellation events', async () => {
    await route(waitingEvent('permission', 'Approve the exact request'));

    expect(mocks.notifyUser).toHaveBeenCalledWith({
      title: 'Agent 等待你的输入',
      body: 'Private session title：Approve the exact request',
      level: 'waiting',
    });
    expect(mocks.logger.warn).not.toHaveBeenCalled();

    mocks.notifyUser.mockClear();
    mocks.sessionGet.mockClear();
    await route(waitingEvent('permission-cancelled', 'must stay silent'));
    expect(mocks.sessionGet).not.toHaveBeenCalled();
    expect(mocks.notifyUser).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    [true, undefined, 'Agent 完成'],
    [false, 'interrupted', 'Agent 已中断'],
    [false, 'provider-error', 'Agent 出错'],
  ])('preserves finished notification title for ok=%s subtype=%s', async (ok, subtype, title) => {
    await route(finishedEvent(ok as boolean, subtype as string | undefined));

    expect(mocks.notifyUser).toHaveBeenCalledWith({
      title,
      body: 'Private session title',
      level: 'finished',
    });
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('summarizes repeated failure at five minutes and emits one healthy recovery', async () => {
    await route(waitingEvent());
    expect(mocks.logger.warn).not.toHaveBeenCalled();

    let failNotification = true;
    mocks.notifyUser.mockImplementation(() => {
      if (failNotification) throw new Error('RAW_ROUTER_FAILURE token=private');
    });
    vi.setSystemTime(1);
    await route(waitingEvent());
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'notification routing degraded',
      expect.objectContaining({
        operation: 'waiting-for-user',
        state: 'notification-failed',
        previousState: 'healthy',
        transition: 'transition',
      }),
    );

    vi.setSystemTime(2);
    await route(waitingEvent());
    await route(waitingEvent('permission-cancelled'));
    vi.setSystemTime(300_000);
    await route(waitingEvent());
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);

    vi.setSystemTime(300_001);
    await route(waitingEvent());
    expect(mocks.logger.warn).toHaveBeenLastCalledWith(
      'notification routing remains degraded',
      expect.objectContaining({
        previousState: 'notification-failed',
        transition: 'periodic-summary',
        abnormalDurationMs: 300_000,
        suppressedCount: 2,
        suppressedCountCapped: false,
      }),
    );

    failNotification = false;
    vi.setSystemTime(300_002);
    await route(waitingEvent());
    expect(mocks.logger.info).toHaveBeenCalledOnce();
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'notification routing recovered',
      expect.objectContaining({
        operation: 'waiting-for-user',
        state: 'healthy',
        previousState: 'notification-failed',
        transition: 'transition',
        abnormalDurationMs: 300_001,
      }),
    );
    expect(loggedText()).not.toMatch(/RAW_|private-token|private-session/);
  });

  it('keeps waiting and finished operation state independent within capacity two', async () => {
    mocks.notifyUser.mockImplementation(() => {
      throw new Error('RAW_INDEPENDENT_FAILURE');
    });
    await route(waitingEvent());
    await route(finishedEvent(false, 'provider-error'));
    expect(mocks.logger.warn).toHaveBeenCalledTimes(2);
    expect(mocks.logger.warn.mock.calls.map((call) => (
      (call[1] as { operation: string }).operation
    ))).toEqual(['waiting-for-user', 'finished']);

    mocks.notifyUser.mockImplementation(() => {});
    await route(waitingEvent());
    expect(mocks.logger.info).toHaveBeenCalledOnce();
    expect(mocks.logger.info.mock.calls[0]?.[1]).toMatchObject({
      operation: 'waiting-for-user',
      state: 'healthy',
    });

    mocks.notifyUser.mockImplementation(() => {
      throw new Error('RAW_FINISHED_REPEAT');
    });
    await route(finishedEvent(false, 'provider-error'));
    expect(mocks.logger.warn).toHaveBeenCalledTimes(2);
    expect(loggedText()).not.toContain('RAW_');
  });

  it.each([
    ['logger scope', () => mocks.loggerScope.mockImplementation(() => {
      throw new Error('RAW_SCOPE_MARKER');
    })],
    ['safe diagnostic', () => mocks.safeDiagnostic.mockImplementation(() => {
      throw new Error('RAW_DIAGNOSTIC_MARKER');
    })],
    ['run id', () => mocks.getProcessRunId.mockImplementation(() => {
      throw new Error('RAW_RUN_ID_MARKER');
    })],
    ['logger sink', () => mocks.logger.warn.mockImplementation(() => {
      throw new Error('RAW_LOGGER_MARKER');
    })],
    ['clock', () => vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('RAW_CLOCK_MARKER');
    })],
  ])('contains %s failure without changing notification routing', async (_name, fail) => {
    fail();
    mocks.notifyUser.mockImplementation(() => {
      throw new Error('RAW_BUSINESS_MARKER /Users/private/repo');
    });

    await expect(route(waitingEvent())).resolves.toBeUndefined();
    expect(mocks.notifyUser).toHaveBeenCalledOnce();
    expect(loggedText()).not.toMatch(/RAW_BUSINESS|\/Users\/private|private-session-id/);
  });

  it('configures capacity two and contains tracker observation failure', async () => {
    const trackerOptions: unknown[] = [];
    vi.doMock('@main/utils/log-state-tracker', () => ({
      BoundedLogStateTracker: class {
        constructor(options: unknown) {
          trackerOptions.push(options);
        }

        observe(): never {
          throw new Error('RAW_TRACKER_MARKER');
        }
      },
    }));
    try {
      await expect(route(waitingEvent())).resolves.toBeUndefined();
      expect(mocks.notifyUser).toHaveBeenCalledWith({
        title: 'Agent 等待你的输入',
        body: 'Private session title：Approve this action',
        level: 'waiting',
      });
      expect(trackerOptions).toEqual([
        {
          capacity: 2,
          summaryIntervalMs: 300_000,
        },
      ]);
    } finally {
      vi.doUnmock('@main/utils/log-state-tracker');
      vi.resetModules();
    }
  });
});
