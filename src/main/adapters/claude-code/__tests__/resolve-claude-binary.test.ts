import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BoundedLogStateTrackerOptions,
  LogStateObservation,
} from '@main/utils/log-state-tracker';

const mocks = vi.hoisted(() => ({
  settingsGet: vi.fn(),
  existsSync: vi.fn(),
  bundledBinary: vi.fn(),
  loggerScope: vi.fn(),
  safeDiagnostic: vi.fn(),
  getProcessRunId: vi.fn(),
  trackerMode: 'normal' as 'normal' | 'construct-throw' | 'observe-throw',
  trackerOptions: [] as BoundedLogStateTrackerOptions[],
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: mocks.settingsGet },
}));
vi.mock('@main/adapters/claude-code/sdk-runtime', () => ({
  getPathToClaudeCodeExecutable: mocks.bundledBinary,
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: mocks.existsSync,
}));
vi.mock('@main/utils/logger', () => ({
  default: { scope: mocks.loggerScope },
}));
vi.mock('@main/utils/safe-diagnostic', () => ({
  safeDiagnostic: mocks.safeDiagnostic,
}));
vi.mock('@main/utils/run-context', () => ({
  getProcessRunId: mocks.getProcessRunId,
}));
vi.mock('@main/utils/log-state-tracker', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@main/utils/log-state-tracker')>();
  class ControlledTracker<
    Key,
    Signature extends string,
  > extends actual.BoundedLogStateTracker<Key, Signature> {
    constructor(options: BoundedLogStateTrackerOptions = {}) {
      mocks.trackerOptions.push(options);
      if (mocks.trackerMode === 'construct-throw') {
        throw new Error('tracker constructor secret');
      }
      super(options);
    }

    override observe(
      key: Key,
      observation: LogStateObservation<Signature>,
    ) {
      if (mocks.trackerMode === 'observe-throw') {
        throw new Error('tracker observe secret');
      }
      return super.observe(key, observation);
    }
  }
  return { ...actual, BoundedLogStateTracker: ControlledTracker };
});

type Subject = typeof import('../resolve-claude-binary');

async function freshSubject(): Promise<Subject> {
  vi.resetModules();
  return import('../resolve-claude-binary');
}

function diagnostic(
  level: 'info' | 'warn',
  index = 0,
): Record<string, unknown> {
  return mocks.logger[level].mock.calls[index]?.[1] as Record<string, unknown>;
}

function loggedText(): string {
  return JSON.stringify(
    Object.values(mocks.logger).flatMap((method) => method.mock.calls),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  mocks.trackerMode = 'normal';
  mocks.trackerOptions.length = 0;
  mocks.loggerScope.mockReturnValue(mocks.logger);
  mocks.safeDiagnostic.mockImplementation((value: unknown) => value);
  mocks.getProcessRunId.mockReturnValue('binary-test-run');
  mocks.settingsGet.mockReturnValue(null);
  mocks.existsSync.mockReturnValue(false);
  mocks.bundledBinary.mockReturnValue('/bundled/claude');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('resolveClaudeBinary', () => {
  it.each([null, '', '   \t  '])(
    'uses the bundled fallback for an absent or empty override: %j',
    async (override) => {
      mocks.settingsGet.mockReturnValue(override);
      const subject = await freshSubject();

      expect(subject.resolveClaudeBinary()).toBe('/bundled/claude');
      expect(mocks.settingsGet).toHaveBeenCalledWith('claudeCliPath');
      expect(mocks.existsSync).not.toHaveBeenCalled();
      expect(mocks.bundledBinary).toHaveBeenCalledOnce();
      expect(mocks.logger.warn).not.toHaveBeenCalled();
      expect(mocks.logger.info).not.toHaveBeenCalled();
    },
  );

  it('trims an existing override and gives it priority over the fallback', async () => {
    const rawPath = '  /Users/private/bin/claude?token=secret  ';
    mocks.settingsGet.mockReturnValue(rawPath);
    mocks.existsSync.mockReturnValue(true);
    const subject = await freshSubject();

    expect(subject.resolveClaudeBinary()).toBe(
      '/Users/private/bin/claude?token=secret',
    );
    expect(mocks.existsSync).toHaveBeenCalledWith(
      '/Users/private/bin/claude?token=secret',
    );
    expect(mocks.bundledBinary).not.toHaveBeenCalled();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();
  });

  it('falls back for a missing override and emits only fixed fields', async () => {
    mocks.settingsGet.mockReturnValue(
      '/Users/private/missing-claude?token=secret',
    );
    mocks.existsSync.mockReturnValue(false);
    const subject = await freshSubject();

    expect(subject.resolveClaudeBinary()).toBe('/bundled/claude');
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Claude configuration state degraded',
      {
        event: 'claude-configuration-state',
        runId: 'binary-test-run',
        operation: 'binary',
        state: 'override-missing',
        previousState: null,
        transition: 'initial',
        abnormalDuration: 0,
        suppressedCount: 0,
        capped: false,
        summaryInterval: 300_000,
      },
    );
    expect(Object.keys(diagnostic('warn')).sort()).toEqual(
      [
        'event',
        'runId',
        'operation',
        'state',
        'previousState',
        'transition',
        'abnormalDuration',
        'suppressedCount',
        'capped',
        'summaryInterval',
      ].sort(),
    );
    expect(loggedText()).not.toMatch(
      /missing-claude|Users|token=secret|\/bundled\/claude/,
    );
    expect(mocks.trackerOptions).toContainEqual(
      expect.objectContaining({ capacity: 1, summaryIntervalMs: 300_000 }),
    );
  });

  it('suppresses repeats, summarizes at five minutes, and supports both recovery paths', async () => {
    const override = '/private/missing-binary';
    mocks.settingsGet.mockReturnValue(override);
    mocks.existsSync.mockReturnValue(false);
    const subject = await freshSubject();

    subject.resolveClaudeBinary();
    vi.setSystemTime(1);
    subject.resolveClaudeBinary();
    vi.setSystemTime(299_999);
    subject.resolveClaudeBinary();
    expect(mocks.logger.warn).toHaveBeenCalledOnce();

    vi.setSystemTime(300_000);
    subject.resolveClaudeBinary();
    expect(mocks.logger.warn).toHaveBeenLastCalledWith(
      'Claude configuration state remains degraded',
      expect.objectContaining({
        state: 'override-missing',
        previousState: 'override-missing',
        transition: 'periodic-summary',
        abnormalDuration: 300_000,
        suppressedCount: 2,
        capped: false,
      }),
    );

    mocks.existsSync.mockReturnValue(true);
    vi.setSystemTime(300_001);
    expect(subject.resolveClaudeBinary()).toBe(override);
    expect(mocks.logger.info).toHaveBeenCalledOnce();
    expect(diagnostic('info')).toMatchObject({
      state: 'healthy',
      previousState: 'override-missing',
      transition: 'transition',
    });
    subject.resolveClaudeBinary();
    expect(mocks.logger.info).toHaveBeenCalledOnce();

    mocks.existsSync.mockReturnValue(false);
    vi.setSystemTime(300_002);
    subject.resolveClaudeBinary();
    expect(mocks.logger.warn).toHaveBeenCalledTimes(3);
    mocks.settingsGet.mockReturnValue(null);
    vi.setSystemTime(300_003);
    expect(subject.resolveClaudeBinary()).toBe('/bundled/claude');
    expect(mocks.logger.info).toHaveBeenCalledTimes(2);
  });

  it.each(['exists', 'fallback'] as const)(
    'preserves a thrown %s error exactly',
    async (seam) => {
      const rawError = new Error(`RAW_${seam.toUpperCase()}_ERROR`);
      if (seam === 'exists') {
        mocks.settingsGet.mockReturnValue('/private/override');
        mocks.existsSync.mockImplementation(() => {
          throw rawError;
        });
      } else {
        mocks.settingsGet.mockReturnValue(null);
        mocks.bundledBinary.mockImplementation(() => {
          throw rawError;
        });
      }
      const subject = await freshSubject();

      expect(() => subject.resolveClaudeBinary()).toThrow(rawError);
    },
  );

  it.each([
    'scope',
    'tracker-constructor',
    'tracker-observe',
    'serializer',
    'run-id',
    'sink',
    'clock',
  ] as const)(
    'contains a %s diagnostic failure without changing fallback behavior',
    async (seam) => {
      mocks.settingsGet.mockReturnValue('/private/missing-override');
      mocks.existsSync.mockReturnValue(false);
      if (seam === 'scope') {
        mocks.loggerScope.mockImplementation(() => {
          throw new Error('RAW_SCOPE');
        });
      }
      if (seam === 'tracker-constructor') {
        mocks.trackerMode = 'construct-throw';
      }
      const subject = await freshSubject();
      if (seam === 'tracker-observe') mocks.trackerMode = 'observe-throw';
      if (seam === 'serializer') {
        mocks.safeDiagnostic.mockImplementation(() => {
          throw new Error('RAW_SERIALIZER');
        });
      }
      if (seam === 'run-id') {
        mocks.getProcessRunId.mockImplementation(() => {
          throw new Error('RAW_RUN_ID');
        });
      }
      if (seam === 'sink') {
        mocks.logger.warn.mockImplementation(() => {
          throw new Error('RAW_SINK');
        });
      }
      if (seam === 'clock') {
        vi.spyOn(Date, 'now').mockImplementation(() => {
          throw new Error('RAW_CLOCK');
        });
      }

      expect(subject.resolveClaudeBinary()).toBe('/bundled/claude');
      expect(mocks.existsSync).toHaveBeenCalledWith(
        '/private/missing-override',
      );
      expect(mocks.bundledBinary).toHaveBeenCalledOnce();
    },
  );
});
