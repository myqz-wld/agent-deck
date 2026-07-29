import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginItemApp } from '../login-item';

const mocks = vi.hoisted(() => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    logger,
    loggerScope: vi.fn(() => logger),
    safeDiagnostic: vi.fn((value: unknown) => value),
    getProcessRunId: vi.fn(() => 'login-item-test-run'),
  };
});

vi.mock('@main/utils/logger', () => ({ default: { scope: mocks.loggerScope } }));
vi.mock('@main/utils/safe-diagnostic', () => ({ safeDiagnostic: mocks.safeDiagnostic }));
vi.mock('@main/utils/run-context', () => ({ getProcessRunId: mocks.getProcessRunId }));

let subject: typeof import('../login-item');

function loginItem(
  partial: Partial<Electron.LoginItemSettings>,
): Electron.LoginItemSettings {
  return {
    openAtLogin: false,
    openAsHidden: false,
    wasOpenedAtLogin: false,
    wasOpenedAsHidden: false,
    restoreState: false,
    status: 'not-registered',
    executableWillLaunchAtLogin: false,
    launchItems: [],
    ...partial,
  };
}

function fakeApp(current: Electron.LoginItemSettings): {
  app: LoginItemApp; getLoginItemSettings: ReturnType<typeof vi.fn>;
  setLoginItemSettings: ReturnType<typeof vi.fn>;
} {
  const getLoginItemSettings = vi.fn(() => current);
  const setLoginItemSettings = vi.fn();
  return {
    app: {
      getLoginItemSettings,
      setLoginItemSettings,
    },
    getLoginItemSettings,
    setLoginItemSettings,
  };
}

function loggedText(): string {
  return [
    ...mocks.logger.info.mock.calls,
    ...mocks.logger.warn.mock.calls,
    ...mocks.logger.error.mock.calls,
  ].flat().map(String).join(' ');
}

describe('login item sync', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mocks.loggerScope.mockReturnValue(mocks.logger);
    mocks.safeDiagnostic.mockImplementation((value: unknown) => value);
    mocks.getProcessRunId.mockReturnValue('login-item-test-run');
    subject = await import('../login-item');
  });
  afterEach(() => {
    vi.doUnmock('@main/utils/log-state-tracker');
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it.each([
    ['unsupported platform', { dev: false, platform: 'linux' as const }, 'unsupported'],
    ['development mode', { dev: true, platform: 'darwin' as const }, 'dev-skipped'],
  ])('skips %s without reading, writing, or observing', (_name, options, expected) => {
    const { app, getLoginItemSettings, setLoginItemSettings } = fakeApp(loginItem({}));
    expect(subject.syncLoginItemSetting(true, { app, ...options })).toBe(expected);
    expect(getLoginItemSettings).not.toHaveBeenCalled();
    expect(setLoginItemSettings).not.toHaveBeenCalled();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();
  });

  it('keeps macOS reads, writes, and approval deduplication unchanged', () => {
    const enabled = fakeApp(loginItem({ openAtLogin: true, status: 'enabled' }));
    expect(
      subject.syncLoginItemSetting(true, {
        app: enabled.app,
        dev: false,
        platform: 'darwin',
      }),
    ).toBe('already-current');
    expect(enabled.getLoginItemSettings).toHaveBeenCalledWith({
      type: 'mainAppService',
    });
    expect(enabled.setLoginItemSettings).not.toHaveBeenCalled();

    const pending = fakeApp(
      loginItem({ openAtLogin: false, status: 'requires-approval' }),
    );
    expect(
      subject.syncLoginItemSetting(true, {
        app: pending.app,
        dev: false,
        platform: 'darwin',
      }),
    ).toBe('already-current');
    expect(pending.setLoginItemSettings).not.toHaveBeenCalled();

    const missing = fakeApp(
      loginItem({ openAtLogin: true, status: 'not-found' }),
    );
    expect(
      subject.syncLoginItemSetting(true, {
        app: missing.app,
        dev: false,
        platform: 'darwin',
      }),
    ).toBe('updated');
    expect(missing.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      type: 'mainAppService',
    });

    const disable = fakeApp(
      loginItem({ openAtLogin: true, status: 'enabled' }),
    );
    expect(
      subject.syncLoginItemSetting(false, {
        app: disable.app,
        dev: false,
        platform: 'darwin',
      }),
    ).toBe('updated');
    expect(disable.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: false,
      type: 'mainAppService',
    });
  });

  it('keeps Windows comparison and write parameters unchanged', () => {
    expect(
      subject.shouldUpdateLoginItem(
        true,
        loginItem({ openAtLogin: false }),
        'win32',
      ),
    ).toBe(true);
    expect(
      subject.shouldUpdateLoginItem(
        true,
        loginItem({ openAtLogin: true }),
        'win32',
      ),
    ).toBe(false);

    const windows = fakeApp(loginItem({ openAtLogin: false }));
    expect(
      subject.syncLoginItemSetting(true, {
        app: windows.app,
        dev: false,
        platform: 'win32',
      }),
    ).toBe('updated');
    expect(windows.getLoginItemSettings).toHaveBeenCalledWith(undefined);
    expect(windows.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
    });
  });

  it('reports a content-free read failure without manufacturing same-call recovery', () => {
    const rawError = new Error(
      'RAW_LOGIN_READ token=private /Users/private/repo https://private.test',
    );
    rawError.name = 'PrivateLoginError';
    const getLoginItemSettings = vi.fn(() => {
      throw rawError;
    });
    const setLoginItemSettings = vi.fn();
    const app = { getLoginItemSettings, setLoginItemSettings };

    expect(
      subject.syncLoginItemSetting(true, {
        app,
        dev: false,
        platform: 'darwin',
      }),
    ).toBe('updated');
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      type: 'mainAppService',
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith('login item state degraded', {
      event: 'login-item-state',
      runId: 'login-item-test-run',
      operation: 'login-item',
      state: 'read-failed',
      previousState: null,
      transition: 'initial',
      abnormalDurationMs: 0,
      suppressedCount: 0,
      suppressedCountCapped: false,
      summaryIntervalMs: 300_000,
    });
    expect(mocks.logger.info).not.toHaveBeenCalled();
    expect(loggedText()).not.toMatch(
      /RAW_LOGIN|PrivateLoginError|private|\/Users\/private|https:\/\//,
    );
    const details = mocks.logger.warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(details).sort()).toEqual(
      [
        'event',
        'runId',
        'operation',
        'state',
        'previousState',
        'transition',
        'abnormalDurationMs',
        'suppressedCount',
        'suppressedCountCapped',
        'summaryIntervalMs',
      ].sort(),
    );
  });

  it('suppresses repeats, summarizes at five minutes, and recovers after a complete read', () => {
    let shouldFail = true;
    const getLoginItemSettings = vi.fn(() => {
      if (shouldFail) throw new Error('RAW_LOGIN_REPEAT');
      return loginItem({ openAtLogin: true, status: 'enabled' });
    });
    const setLoginItemSettings = vi.fn();
    const app = { getLoginItemSettings, setLoginItemSettings };
    const sync = (): string =>
      subject.syncLoginItemSetting(true, {
        app,
        dev: false,
        platform: 'darwin',
      });

    expect(sync()).toBe('updated');
    vi.setSystemTime(1);
    for (let index = 0; index < 10_005; index += 1) sync();
    vi.setSystemTime(299_999);
    expect(sync()).toBe('updated');
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);

    vi.setSystemTime(300_000);
    expect(sync()).toBe('updated');
    expect(mocks.logger.warn).toHaveBeenLastCalledWith(
      'login item state remains degraded',
      expect.objectContaining({
        state: 'read-failed',
        previousState: 'read-failed',
        transition: 'periodic-summary',
        abnormalDurationMs: 300_000,
        suppressedCount: 9_999,
        suppressedCountCapped: true,
      }),
    );

    shouldFail = false;
    vi.setSystemTime(300_001);
    expect(sync()).toBe('already-current');
    expect(mocks.logger.info).toHaveBeenCalledOnce();
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'login item state recovered',
      expect.objectContaining({
        state: 'healthy',
        previousState: 'read-failed',
        transition: 'transition',
        abnormalDurationMs: 300_001,
      }),
    );
    vi.setSystemTime(300_002);
    expect(sync()).toBe('already-current');
    expect(mocks.logger.info).toHaveBeenCalledOnce();
  });

  it('keeps approval-required distinct and recovers only after approval clears', () => {
    let current = loginItem({
      openAtLogin: false,
      status: 'requires-approval',
    });
    const app = {
      getLoginItemSettings: vi.fn(() => current),
      setLoginItemSettings: vi.fn(),
    };

    expect(
      subject.syncLoginItemSetting(true, {
        app,
        dev: false,
        platform: 'darwin',
      }),
    ).toBe('already-current');
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'login item state degraded',
      expect.objectContaining({
        state: 'approval-required',
        previousState: null,
      }),
    );
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();

    current = loginItem({ openAtLogin: true, status: 'enabled' });
    vi.setSystemTime(1);
    expect(
      subject.syncLoginItemSetting(true, {
        app,
        dev: false,
        platform: 'darwin',
      }),
    ).toBe('already-current');
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'login item state recovered',
      expect.objectContaining({
        state: 'healthy',
        previousState: 'approval-required',
      }),
    );
  });

  it('emits an abnormal signature transition from read failure to approval required', () => {
    let readCount = 0;
    const app = {
      getLoginItemSettings: vi.fn(() => {
        readCount += 1;
        if (readCount === 1) throw new Error('RAW_LOGIN_TRANSITION');
        return loginItem({
          openAtLogin: false,
          status: 'requires-approval',
        });
      }),
      setLoginItemSettings: vi.fn(),
    };

    subject.syncLoginItemSetting(true, {
      app,
      dev: false,
      platform: 'darwin',
    });
    vi.setSystemTime(1);
    subject.syncLoginItemSetting(true, {
      app,
      dev: false,
      platform: 'darwin',
    });

    expect(mocks.logger.warn).toHaveBeenLastCalledWith(
      'login item state degraded',
      expect.objectContaining({
        state: 'approval-required',
        previousState: 'read-failed',
        transition: 'transition',
      }),
    );
  });

  it('does not observe skipped calls as recovery', () => {
    const app = {
      getLoginItemSettings: vi.fn(() => {
        throw new Error('RAW_LOGIN_SKIP');
      }),
      setLoginItemSettings: vi.fn(),
    };
    subject.syncLoginItemSetting(true, {
      app,
      dev: false,
      platform: 'darwin',
    });

    subject.syncLoginItemSetting(true, {
      app,
      dev: false,
      platform: 'linux',
    });
    subject.syncLoginItemSetting(true, {
      app,
      dev: true,
      platform: 'darwin',
    });
    expect(mocks.logger.info).not.toHaveBeenCalled();
  });

  it('rethrows the exact set failure without classifying it or logging healthy', () => {
    const setFailure = new Error('RAW_LOGIN_SET');
    const app = {
      getLoginItemSettings: vi.fn(() =>
        loginItem({ openAtLogin: false, status: 'not-registered' }),
      ),
      setLoginItemSettings: vi.fn(() => {
        throw setFailure;
      }),
    };

    expect(() =>
      subject.syncLoginItemSetting(true, {
        app,
        dev: false,
        platform: 'darwin',
      }),
    ).toThrow(setFailure);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();
  });

  it.each([
    ['serializer', () => mocks.safeDiagnostic.mockImplementation(() => {
      throw new Error('RAW_LOGIN_SERIALIZER');
    })],
    ['run id', () => mocks.getProcessRunId.mockImplementation(() => {
      throw new Error('RAW_LOGIN_RUN_ID');
    })],
    ['sink', () => mocks.logger.warn.mockImplementation(() => {
      throw new Error('RAW_LOGIN_SINK');
    })],
    ['clock', () => vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('RAW_LOGIN_CLOCK');
    })],
  ])('contains %s failure without changing fallback write behavior', (_name, fail) => {
    fail();
    const app = {
      getLoginItemSettings: vi.fn(() => {
        throw new Error('RAW_LOGIN_BUSINESS');
      }),
      setLoginItemSettings: vi.fn(),
    };

    expect(
      subject.syncLoginItemSetting(true, {
        app,
        dev: false,
        platform: 'darwin',
      }),
    ).toBe('updated');
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      type: 'mainAppService',
    });
  });

  it('contains logger scope failure without changing login item behavior', async () => {
    vi.resetModules();
    mocks.loggerScope.mockImplementation(() => {
      throw new Error('RAW_LOGIN_SCOPE');
    });
    const fresh = await import('../login-item');
    const current = fakeApp(loginItem({ openAtLogin: true, status: 'enabled' }));

    expect(
      fresh.syncLoginItemSetting(true, {
        app: current.app,
        dev: false,
        platform: 'darwin',
      }),
    ).toBe('already-current');
  });

  it('uses a one-entry tracker and contains tracker failure', async () => {
    const options: unknown[] = [];
    vi.resetModules();
    vi.doMock('@main/utils/log-state-tracker', () => ({
      BoundedLogStateTracker: class {
        constructor(value: unknown) {
          options.push(value);
        }

        observe(): never {
          throw new Error('RAW_LOGIN_TRACKER');
        }
      },
    }));
    const fresh = await import('../login-item');
    const app = {
      getLoginItemSettings: vi.fn(() => {
        throw new Error('RAW_LOGIN_READ');
      }),
      setLoginItemSettings: vi.fn(),
    };

    expect(
      fresh.syncLoginItemSetting(true, {
        app,
        dev: false,
        platform: 'darwin',
      }),
    ).toBe('updated');
    expect(options).toEqual([
      {
        capacity: 1,
        summaryIntervalMs: 300_000,
      },
    ]);
  });
});
