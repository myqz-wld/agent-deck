import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcEvent } from '@shared/ipc-channels';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const window = { isDestroyed: vi.fn(() => false), isAlwaysOnTop: vi.fn(() => true) };
  const floating = {
    window,
    windowTransparent: false,
    create: vi.fn(),
    setWindowTransparent: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    toggleMaximize: vi.fn(),
    toggleDefault: vi.fn(),
    emitCompactChanged: vi.fn(),
  };
  return {
    listeners,
    logger,
    window,
    floating,
    loggerScope: vi.fn(() => logger),
    safeDiagnostic: vi.fn((value: unknown) => value),
    getProcessRunId: vi.fn(() => 'bootstrap-wiring-test-run'),
    shortcutRegister: vi.fn((_accelerator: string, _callback: () => void) => true),
    getFloatingWindow: vi.fn(() => floating),
    eventOn: vi.fn((_event: string, _listener: (...args: unknown[]) => void) => () => {}),
    safeSend: vi.fn(),
    makeSafeSend: vi.fn(),
    makeDebouncedTeamSender: vi.fn(),
    enrichWithTeams: vi.fn((value: unknown) => value),
    notifyUser: vi.fn(),
    handleCliArgv: vi.fn(),
    rememberSessionFocusRequest: vi.fn(),
    ensureFocusableOnActivate: vi.fn(),
  };
});

vi.mock('electron', () => ({
  globalShortcut: { register: mocks.shortcutRegister },
}));

vi.mock('@main/window', () => ({
  ensureFocusableOnActivate: mocks.ensureFocusableOnActivate,
  getFloatingWindow: mocks.getFloatingWindow,
}));

vi.mock('@main/event-bus', () => ({ eventBus: { on: mocks.eventOn } }));
vi.mock('@main/session/manager', () => ({
  sessionManager: { enrichWithTeams: mocks.enrichWithTeams },
}));
vi.mock('@main/notify/visual', () => ({ notifyUser: mocks.notifyUser }));
vi.mock('@main/cli', () => ({ handleCliArgv: mocks.handleCliArgv }));
vi.mock('@main/session-focus-request', () => ({
  rememberSessionFocusRequest: mocks.rememberSessionFocusRequest,
}));

vi.mock('@main/index/_deps', () => ({
  makeSafeSend: mocks.makeSafeSend,
  makeDebouncedTeamSender: mocks.makeDebouncedTeamSender,
  TOOL_DISPLAY_NAME: {
    archive_plan: 'plan 归档',
    hand_off_session: '会话接力',
    SessionHandOffCommit: '会话接力',
  },
}));

vi.mock('@main/utils/logger', () => ({ default: { scope: mocks.loggerScope } }));
vi.mock('@main/utils/safe-diagnostic', () => ({ safeDiagnostic: mocks.safeDiagnostic }));
vi.mock('@main/utils/run-context', () => ({ getProcessRunId: mocks.getProcessRunId }));

async function initializeWiring(): Promise<void> {
  const { initWiring } = await import('../bootstrap-wiring');
  initWiring({
    windowTransparent: false,
    alwaysOnTop: true,
  } as never);
}

function listener(event: string): (...args: unknown[]) => void {
  const registered = mocks.listeners.get(event);
  if (!registered) throw new Error(`missing test listener: ${event}`);
  return registered;
}

function loggedText(): string {
  return [
    ...mocks.logger.info.mock.calls,
    ...mocks.logger.warn.mock.calls,
    ...mocks.logger.error.mock.calls,
  ].flat().map(String).join(' ');
}

describe('bootstrap wiring observability', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mocks.listeners.clear();

    mocks.loggerScope.mockReturnValue(mocks.logger);
    mocks.safeDiagnostic.mockImplementation((value: unknown) => value);
    mocks.getProcessRunId.mockReturnValue('bootstrap-wiring-test-run');
    mocks.shortcutRegister.mockReturnValue(true);
    mocks.getFloatingWindow.mockReturnValue(mocks.floating);
    mocks.window.isDestroyed.mockReturnValue(false);
    mocks.window.isAlwaysOnTop.mockReturnValue(true);
    mocks.makeSafeSend.mockReturnValue(mocks.safeSend);
    mocks.makeDebouncedTeamSender.mockImplementation(() => vi.fn());
    mocks.enrichWithTeams.mockImplementation((value: unknown) => value);
    mocks.floating.emitCompactChanged = vi.fn();
    mocks.eventOn.mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      mocks.listeners.set(event, listener);
      return () => {};
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('aggregates shortcut registration failures without exposing accelerators', async () => {
    mocks.shortcutRegister
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false);

    await initializeWiring();

    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(
      'CommandOrControl',
    );
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'shortcut registration failed',
      {
        event: 'shortcut-registration-failed',
        runId: 'bootstrap-wiring-test-run',
        failedCount: 3,
      },
    );
    expect(mocks.shortcutRegister.mock.calls.map(([accelerator]) => accelerator)).toEqual([
      'CommandOrControl+Alt+P',
      'CommandOrControl+Alt+T',
      'CommandOrControl+Alt+=',
      'CommandOrControl+Alt+-',
    ]);
    expect(mocks.eventOn.mock.calls.map(([event]) => event)).toEqual(
      ('agent-event|session-upserted|session-removed|session-renamed|summary-added|' +
       'session-focus-request|task-changed|issue-changed|token-usage-changed|token-rate-tick|' +
       'caller-archive-failed|agent-deck-team-created|agent-deck-team-updated|' +
       'agent-deck-team-deleted|agent-deck-team-member-changed|agent-deck-message-enqueued|' +
       'agent-deck-message-status-changed|agent-deck-message-purged').split('|'),
    );
  });

  it('rate-limits projection failure, summarizes at five minutes, and logs one recovery', async () => {
    await initializeWiring();
    const sessionProjection = listener('session-upserted');
    const rawSession = { id: 'raw-private-session-id' };
    const projected = { id: 'projected-session' };

    mocks.enrichWithTeams.mockReturnValueOnce(projected);
    sessionProjection(rawSession);
    expect(mocks.safeSend).toHaveBeenCalledWith(IpcEvent.SessionUpserted, projected);
    expect(mocks.logger.warn).not.toHaveBeenCalled();

    vi.setSystemTime(1);
    mocks.enrichWithTeams.mockImplementation(() => {
      throw new Error(
        'RAW_PROJECTION_MARKER token=private /Users/private/repo https://private.test',
      );
    });
    expect(() => sessionProjection(rawSession)).not.toThrow();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'bootstrap event bridge degraded',
      {
        event: 'bootstrap-event-bridge-state',
        runId: 'bootstrap-wiring-test-run',
        operation: 'session-projection',
        state: 'session-projection-failed',
        previousState: 'healthy',
        transition: 'transition',
        abnormalDurationMs: 0,
        suppressedCount: 0,
        suppressedCountCapped: false,
        summaryIntervalMs: 300_000,
      },
    );

    vi.setSystemTime(2);
    sessionProjection(rawSession);
    vi.setSystemTime(300_000);
    sessionProjection(rawSession);
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);

    vi.setSystemTime(300_001);
    sessionProjection(rawSession);
    expect(mocks.logger.warn).toHaveBeenLastCalledWith(
      'bootstrap event bridge remains degraded',
      expect.objectContaining({
        operation: 'session-projection',
        state: 'session-projection-failed',
        previousState: 'session-projection-failed',
        transition: 'periodic-summary',
        abnormalDurationMs: 300_000,
        suppressedCount: 2,
        suppressedCountCapped: false,
        summaryIntervalMs: 300_000,
      }),
    );

    vi.setSystemTime(300_002);
    mocks.enrichWithTeams.mockReturnValue(projected);
    sessionProjection(rawSession);
    expect(mocks.logger.info).toHaveBeenCalledOnce();
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'bootstrap event bridge recovered',
      expect.objectContaining({
        operation: 'session-projection',
        state: 'healthy',
        previousState: 'session-projection-failed',
        transition: 'transition',
        abnormalDurationMs: 300_001,
      }),
    );
    expect(loggedText()).not.toMatch(
      /RAW_|private-token|private-session|\/Users\/private|https:\/\//,
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

  it('caps repeated projection suppression at the tracker default', async () => {
    await initializeWiring();
    const sessionProjection = listener('session-upserted');
    mocks.enrichWithTeams.mockImplementation(() => {
      throw new Error('RAW_REPEATED_PROJECTION_MARKER');
    });

    sessionProjection({ id: 'raw-id' });
    for (let index = 0; index < 10_005; index += 1) {
      sessionProjection({ id: 'raw-id' });
    }
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);

    vi.setSystemTime(300_000);
    sessionProjection({ id: 'raw-id' });
    expect(mocks.logger.warn).toHaveBeenLastCalledWith(
      'bootstrap event bridge remains degraded',
      expect.objectContaining({
        transition: 'periodic-summary',
        suppressedCount: 9_999,
        suppressedCountCapped: true,
      }),
    );
  });

  it('keeps archive channels independent across signature changes and recovery', async () => {
    await initializeWiring();
    const archiveDispatch = listener('caller-archive-failed');
    const payload = {
      sessionId: '12345678-private-session-id',
      toolName: 'hand_off_session',
      reason: 'RAW_ARCHIVE_REASON token=private /Users/private/repo',
      reasonKind: 'archive-throw',
    };
    let failNotification = true;
    let failIpc = false;
    mocks.notifyUser.mockImplementation(() => {
      if (failNotification) throw new Error('RAW_NOTIFICATION_CHANNEL_MARKER');
    });
    mocks.safeSend.mockImplementation((channel: unknown) => {
      if (channel === IpcEvent.CallerArchiveFailed && failIpc) {
        throw new Error('RAW_IPC_CHANNEL_MARKER');
      }
    });

    expect(() => archiveDispatch(payload)).not.toThrow();
    expect(mocks.notifyUser).toHaveBeenLastCalledWith({
      title: 'Agent Deck 归档失败',
      body: '原会话未归档,可重试归档(12345678…,工具:会话接力)',
      level: 'info',
    });
    expect(mocks.safeSend).toHaveBeenLastCalledWith(
      IpcEvent.CallerArchiveFailed,
      payload,
    );
    expect(mocks.notifyUser.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.safeSend.mock.invocationCallOrder[0]!,
    );
    expect(mocks.logger.warn).toHaveBeenLastCalledWith(
      'bootstrap event bridge degraded',
      expect.objectContaining({
        operation: 'archive-dispatch',
        state: 'archive-notification-failed',
        previousState: null,
        transition: 'initial',
      }),
    );

    vi.setSystemTime(1);
    failNotification = false;
    failIpc = true;
    archiveDispatch(payload);
    expect(mocks.logger.warn).toHaveBeenLastCalledWith(
      'bootstrap event bridge degraded',
      expect.objectContaining({
        state: 'archive-ipc-failed',
        previousState: 'archive-notification-failed',
        transition: 'transition',
      }),
    );

    vi.setSystemTime(2);
    failNotification = true;
    failIpc = true;
    archiveDispatch(payload);
    expect(mocks.logger.warn).toHaveBeenLastCalledWith(
      'bootstrap event bridge degraded',
      expect.objectContaining({
        state: 'archive-dispatch-failed',
        previousState: 'archive-ipc-failed',
        transition: 'transition',
      }),
    );

    vi.setSystemTime(3);
    failNotification = false;
    failIpc = false;
    archiveDispatch(payload);
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'bootstrap event bridge recovered',
      expect.objectContaining({
        operation: 'archive-dispatch',
        state: 'healthy',
        previousState: 'archive-dispatch-failed',
        transition: 'transition',
        abnormalDurationMs: 3,
      }),
    );
    expect(mocks.notifyUser).toHaveBeenCalledTimes(4);
    expect(mocks.safeSend).toHaveBeenCalledTimes(4);
    expect(loggedText()).not.toMatch(
      /RAW_|private|12345678|\/Users\/private|CommandOrControl/,
    );
  });

  it.each([
    [
      'archive-throw',
      '原会话未归档,可重试归档(12345678…,工具:plan 归档)',
    ],
    [
      'probe-throw',
      '数据库异常无法探针原会话,可稍后重试归档(12345678…,工具:plan 归档)',
    ],
    [
      'row-missing',
      '原会话记录不可用,归档未完成(12345678…,工具:plan 归档)',
    ],
  ])('preserves the %s archive notification and IPC payload', async (reasonKind, body) => {
    await initializeWiring();
    const archiveDispatch = listener('caller-archive-failed');
    const payload = {
      sessionId: '12345678-rest',
      toolName: 'archive_plan',
      reason: 'raw UI-facing archive reason',
      reasonKind,
    };

    archiveDispatch(payload);

    expect(mocks.notifyUser).toHaveBeenCalledWith({
      title: 'Agent Deck 归档失败',
      body,
      level: 'info',
    });
    expect(mocks.safeSend).toHaveBeenCalledWith(
      IpcEvent.CallerArchiveFailed,
      payload,
    );
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('contains archive body construction failure at the event boundary', async () => {
    await initializeWiring();
    const archiveDispatch = listener('caller-archive-failed');
    const payload = {
      get sessionId(): string {
        throw new Error('RAW_ARCHIVE_DISPATCH_MARKER /Users/private/repo');
      },
      toolName: 'archive_plan',
      reason: 'raw reason',
      reasonKind: 'row-missing',
    };

    expect(() => archiveDispatch(payload)).not.toThrow();
    expect(mocks.notifyUser).not.toHaveBeenCalled();
    expect(mocks.safeSend).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'bootstrap event bridge degraded',
      expect.objectContaining({
        operation: 'archive-dispatch',
        state: 'archive-dispatch-failed',
      }),
    );
    expect(loggedText()).not.toMatch(/RAW_|\/Users\/private|raw reason/);
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
  ])('contains %s failure without escaping the projection listener', async (_name, fail) => {
    fail();
    await initializeWiring();
    mocks.enrichWithTeams.mockImplementation(() => {
      throw new Error('RAW_BUSINESS_MARKER /Users/private/repo');
    });

    expect(() => listener('session-upserted')({ id: 'raw-session-id' })).not.toThrow();
    expect(mocks.safeSend).not.toHaveBeenCalledWith(
      IpcEvent.SessionUpserted,
      expect.anything(),
    );
    expect(loggedText()).not.toMatch(/RAW_BUSINESS|\/Users\/private|raw-session-id/);
  });

  it('contains shortcut diagnostic failure without changing registration', async () => {
    mocks.shortcutRegister.mockReturnValue(false);
    mocks.safeDiagnostic.mockImplementation(() => {
      throw new Error('RAW_SHORTCUT_DIAGNOSTIC_MARKER');
    });

    await expect(initializeWiring()).resolves.toBeUndefined();
    expect(mocks.shortcutRegister).toHaveBeenCalledTimes(4);
  });

  it('configures the bounded tracker and contains tracker observation failure', async () => {
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
      await initializeWiring();
      const projected = { id: 'projected' };
      mocks.enrichWithTeams.mockReturnValue(projected);

      expect(() => listener('session-upserted')({ id: 'raw-session' })).not.toThrow();
      expect(mocks.safeSend).toHaveBeenCalledWith(IpcEvent.SessionUpserted, projected);
      expect(trackerOptions).toEqual([
        {
          capacity: 8,
          summaryIntervalMs: 300_000,
        },
      ]);
    } finally {
      vi.doUnmock('@main/utils/log-state-tracker');
      vi.resetModules();
    }
  });
});
