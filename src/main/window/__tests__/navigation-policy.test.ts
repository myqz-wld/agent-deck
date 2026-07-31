import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

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
    getProcessRunId: vi.fn(() => 'navigation-test-run'),
  };
});

vi.mock('@main/utils/logger', () => ({
  default: { scope: mocks.loggerScope },
}));
vi.mock('@main/utils/safe-diagnostic', () => ({
  safeDiagnostic: mocks.safeDiagnostic,
}));
vi.mock('@main/utils/run-context', () => ({
  getProcessRunId: mocks.getProcessRunId,
}));

let subject: typeof import('../navigation-policy');

interface NavigationHarness {
  navigate: (event: { preventDefault: () => void }, url: string) => void;
  openWindow: (details: { url: string }) => { action: 'deny' };
  preventDefault: ReturnType<typeof vi.fn>;
}

function install(
  openExternal: (url: string) => Promise<unknown>,
  currentUrl = 'http://localhost:5173/',
): NavigationHarness {
  let navigate:
    | ((event: { preventDefault: () => void }, url: string) => void)
    | null = null;
  let openWindow:
    | ((details: { url: string }) => { action: 'deny' })
    | null = null;
  const webContents = {
    getURL: vi.fn(() => currentUrl),
    on: vi.fn((_event, listener) => {
      navigate = listener;
    }),
    setWindowOpenHandler: vi.fn((handler) => {
      openWindow = handler;
    }),
  } as unknown as Pick<WebContents, 'on' | 'setWindowOpenHandler'>;
  const preventDefault = vi.fn();

  subject.installWindowNavigationPolicy(webContents, openExternal);
  if (!navigate || !openWindow) throw new Error('navigation handlers were not installed');
  return { navigate, openWindow, preventDefault };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function loggedText(): string {
  return [
    ...mocks.logger.info.mock.calls,
    ...mocks.logger.warn.mock.calls,
    ...mocks.logger.error.mock.calls,
  ]
    .flat()
    .map(String)
    .join(' ');
}

describe('window navigation policy', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mocks.loggerScope.mockReturnValue(mocks.logger);
    mocks.safeDiagnostic.mockImplementation((value: unknown) => value);
    mocks.getProcessRunId.mockReturnValue('navigation-test-run');
    subject = await import('../navigation-policy');
  });

  afterEach(() => {
    vi.doUnmock('@main/utils/log-state-tracker');
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('allows only normalized http, https, and mailto targets', () => {
    expect(subject.allowedExternalNavigationUrl('http://example.com/path')).toBe(
      'http://example.com/path',
    );
    expect(subject.allowedExternalNavigationUrl('https://example.com/path')).toBe(
      'https://example.com/path',
    );
    expect(subject.allowedExternalNavigationUrl('mailto:user@example.com')).toBe(
      'mailto:user@example.com',
    );
    expect(subject.allowedExternalNavigationUrl('file:///tmp/source.ts:5')).toBeNull();
    expect(subject.allowedExternalNavigationUrl('javascript:alert(1)')).toBeNull();
    expect(subject.allowedExternalNavigationUrl('not a url')).toBeNull();
  });

  it('preserves navigation blocking, window denial, and external URL arguments', async () => {
    const openExternal = vi.fn(async () => undefined);
    const harness = install(openExternal);

    harness.navigate({ preventDefault: harness.preventDefault }, 'file:///tmp/source.ts:5');
    expect(openExternal).not.toHaveBeenCalled();

    harness.navigate(
      { preventDefault: harness.preventDefault },
      'https://example.com/docs',
    );
    expect(harness.preventDefault).toHaveBeenCalledTimes(2);
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');
    expect(harness.openWindow({ url: 'mailto:user@example.com' })).toEqual({
      action: 'deny',
    });
    expect(openExternal).toHaveBeenCalledWith('mailto:user@example.com');
    await settle();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();
  });

  it('keeps same-origin development reloads inside Electron without opening a browser', async () => {
    const openExternal = vi.fn(async () => undefined);
    const harness = install(openExternal, 'http://localhost:5173/live');

    harness.navigate(
      { preventDefault: harness.preventDefault },
      'http://localhost:5173/',
    );
    expect(harness.preventDefault).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();

    expect(
      harness.openWindow({ url: 'http://localhost:5173/another-path' }),
    ).toEqual({ action: 'deny' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('keeps invalid targets silent while still preventing renderer replacement', async () => {
    const openExternal = vi.fn(async () => undefined);
    const harness = install(openExternal);

    harness.navigate(
      { preventDefault: harness.preventDefault },
      'RAW_INVALID_URL token=private',
    );
    expect(harness.preventDefault).toHaveBeenCalledOnce();
    expect(harness.openWindow({ url: 'file:///Users/private/secret.txt' })).toEqual({
      action: 'deny',
    });
    await settle();

    expect(openExternal).not.toHaveBeenCalled();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();
  });

  it('reports a fixed open failure without URL, error name, or arbitrary content', async () => {
    const rawError = new Error(
      'RAW_EXTERNAL token=private /Users/private/repo https://private.test',
    );
    rawError.name = 'PrivateExternalError';
    const openExternal = vi.fn(() => Promise.reject(rawError));
    const harness = install(openExternal);

    harness.navigate(
      { preventDefault: harness.preventDefault },
      'https://secret.example/private/path?token=hidden',
    );
    await settle();

    expect(mocks.logger.warn).toHaveBeenCalledWith('external open state degraded', {
      event: 'external-open-state',
      runId: 'navigation-test-run',
      operation: 'https',
      state: 'open-failed',
      previousState: null,
      transition: 'initial',
      abnormalDurationMs: 0,
      suppressedCount: 0,
      suppressedCountCapped: false,
      summaryIntervalMs: 300_000,
    });
    expect(loggedText()).not.toMatch(
      /RAW_EXTERNAL|PrivateExternalError|secret\.example|private\/path|hidden|\/Users\/private/,
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

  it('suppresses repeats, summarizes at five minutes, and logs one recovery', async () => {
    let shouldFail = true;
    const openExternal = vi.fn(() =>
      shouldFail ? Promise.reject(new Error('RAW_EXTERNAL_REPEAT')) : Promise.resolve(),
    );
    const harness = install(openExternal);
    const open = async (): Promise<void> => {
      harness.navigate(
        { preventDefault: harness.preventDefault },
        'https://example.com/private',
      );
      await settle();
    };

    await open();
    vi.setSystemTime(1);
    await open();
    vi.setSystemTime(299_999);
    await open();
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);

    vi.setSystemTime(300_000);
    await open();
    expect(mocks.logger.warn).toHaveBeenLastCalledWith(
      'external open state remains degraded',
      expect.objectContaining({
        operation: 'https',
        state: 'open-failed',
        previousState: 'open-failed',
        transition: 'periodic-summary',
        abnormalDurationMs: 300_000,
        suppressedCount: 2,
        suppressedCountCapped: false,
      }),
    );

    shouldFail = false;
    vi.setSystemTime(300_001);
    await open();
    expect(mocks.logger.info).toHaveBeenCalledOnce();
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'external open state recovered',
      expect.objectContaining({
        operation: 'https',
        state: 'healthy',
        previousState: 'open-failed',
        abnormalDurationMs: 300_001,
      }),
    );
    vi.setSystemTime(300_002);
    await open();
    expect(mocks.logger.info).toHaveBeenCalledOnce();
  });

  it('tracks http, https, and mailto independently', async () => {
    const failing = new Set(['http:', 'https:', 'mailto:']);
    const openExternal = vi.fn((url: string) => {
      const protocol = new URL(url).protocol;
      return failing.has(protocol)
        ? Promise.reject(new Error(`RAW_${protocol}`))
        : Promise.resolve();
    });
    const harness = install(openExternal);
    const open = async (url: string): Promise<void> => {
      harness.openWindow({ url });
      await settle();
    };

    await open('http://example.com/a');
    await open('https://example.com/b');
    await open('mailto:user@example.com');
    expect(mocks.logger.warn.mock.calls.map(([, details]) =>
      (details as { operation: string }).operation,
    )).toEqual(['http', 'https', 'mailto']);

    failing.delete('https:');
    await open('https://example.com/recovered');
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'external open state recovered',
      expect.objectContaining({ operation: 'https' }),
    );
    expect(mocks.logger.info).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['serializer', () => mocks.safeDiagnostic.mockImplementation(() => {
      throw new Error('RAW_EXTERNAL_SERIALIZER');
    })],
    ['run id', () => mocks.getProcessRunId.mockImplementation(() => {
      throw new Error('RAW_EXTERNAL_RUN_ID');
    })],
    ['sink', () => mocks.logger.warn.mockImplementation(() => {
      throw new Error('RAW_EXTERNAL_SINK');
    })],
    ['clock', () => vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('RAW_EXTERNAL_CLOCK');
    })],
  ])('contains %s failure without changing external dispatch', async (_name, fail) => {
    fail();
    const openExternal = vi.fn(() => Promise.reject(new Error('RAW_EXTERNAL_BUSINESS')));
    const harness = install(openExternal);

    expect(
      harness.openWindow({ url: 'mailto:user@example.com' }),
    ).toEqual({ action: 'deny' });
    await settle();
    expect(openExternal).toHaveBeenCalledWith('mailto:user@example.com');
  });

  it('contains logger scope failure without changing dispatch', async () => {
    vi.resetModules();
    mocks.loggerScope.mockImplementation(() => {
      throw new Error('RAW_EXTERNAL_SCOPE');
    });
    const fresh = await import('../navigation-policy');
    const openExternal = vi.fn(async () => undefined);
    let handler: ((details: { url: string }) => { action: 'deny' }) | null = null;
    const webContents = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn((value) => {
        handler = value;
      }),
    } as unknown as Pick<WebContents, 'on' | 'setWindowOpenHandler'>;

    fresh.installWindowNavigationPolicy(webContents, openExternal);
    expect(handler!({ url: 'https://example.com/' })).toEqual({ action: 'deny' });
    await settle();
    expect(openExternal).toHaveBeenCalledWith('https://example.com/');
  });

  it('uses a three-entry tracker and contains tracker failure', async () => {
    const options: unknown[] = [];
    vi.resetModules();
    vi.doMock('@main/utils/log-state-tracker', () => ({
      BoundedLogStateTracker: class {
        constructor(value: unknown) {
          options.push(value);
        }

        observe(): never {
          throw new Error('RAW_EXTERNAL_TRACKER');
        }
      },
    }));
    const fresh = await import('../navigation-policy');
    const openExternal = vi.fn(() => Promise.reject(new Error('RAW_OPEN')));
    let handler: ((details: { url: string }) => { action: 'deny' }) | null = null;
    const webContents = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn((value) => {
        handler = value;
      }),
    } as unknown as Pick<WebContents, 'on' | 'setWindowOpenHandler'>;

    fresh.installWindowNavigationPolicy(webContents, openExternal);
    expect(handler!({ url: 'http://example.com/' })).toEqual({ action: 'deny' });
    await settle();
    expect(options).toEqual([
      {
        capacity: 3,
        summaryIntervalMs: 300_000,
      },
    ]);
  });
});
