import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BoundedLogStateTrackerOptions,
  LogStateObservation,
} from '@main/utils/log-state-tracker';

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  loggerScope: vi.fn(),
  safeDiagnostic: vi.fn(),
  getProcessRunId: vi.fn(),
  trackerMode: 'normal' as 'normal' | 'construct-throw' | 'observe-throw',
  trackerOptions: [] as BoundedLogStateTrackerOptions[],
  trackerObserveCount: 0,
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
}));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => '/Users/private-home',
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
      mocks.trackerObserveCount += 1;
      if (mocks.trackerMode === 'observe-throw') {
        throw new Error('tracker observe secret');
      }
      return super.observe(key, observation);
    }
  }
  return { ...actual, BoundedLogStateTracker: ControlledTracker };
});

type Subject = typeof import('../settings-env');

const SETTINGS_PATH = '/Users/private-home/.claude/settings.json';
let originalProcessEnv: NodeJS.ProcessEnv;

async function freshSubject(): Promise<Subject> {
  vi.resetModules();
  return import('../settings-env');
}

function setEnvDocument(env: unknown): void {
  mocks.existsSync.mockReturnValue(true);
  mocks.readFileSync.mockReturnValue(JSON.stringify({ env }));
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
  originalProcessEnv = process.env;
  process.env = { ...originalProcessEnv };
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  mocks.trackerMode = 'normal';
  mocks.trackerOptions.length = 0;
  mocks.trackerObserveCount = 0;
  mocks.loggerScope.mockReturnValue(mocks.logger);
  mocks.safeDiagnostic.mockImplementation((value: unknown) => value);
  mocks.getProcessRunId.mockReturnValue('settings-env-test-run');
  mocks.existsSync.mockReturnValue(false);
});

afterEach(() => {
  process.env = originalProcessEnv;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('applyClaudeSettingsEnv', () => {
  it('treats a missing settings file as healthy without reading it', async () => {
    const subject = await freshSubject();

    expect(subject.applyClaudeSettingsEnv()).toBeUndefined();
    expect(mocks.existsSync).toHaveBeenCalledWith(SETTINGS_PATH);
    expect(mocks.readFileSync).not.toHaveBeenCalled();
    expect(mocks.trackerObserveCount).toBe(1);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();
  });

  it('applies allowed variables in Object.entries order and stays silent', async () => {
    setEnvDocument({
      ANTHROPIC_R6_FIRST: 'first-secret',
      CLAUDE_R6_SECOND: 'second-secret',
      HTTP_PROXY: 'HTTP_PROXY-value',
      HTTPS_PROXY: 'HTTPS_PROXY-value',
      NO_PROXY: 'NO_PROXY-value',
      ALL_PROXY: 'ALL_PROXY-value',
      http_proxy: 'http_proxy-value',
      https_proxy: 'https_proxy-value',
      no_proxy: 'no_proxy-value',
      all_proxy: 'all_proxy-value',
      CLAUDE_R6_LAST: 'last-secret',
    });
    const subject = await freshSubject();
    const assignmentOrder: string[] = [];
    process.env = new Proxy(process.env, {
      set(target, property, value) {
        assignmentOrder.push(String(property));
        return Reflect.set(target, property, String(value));
      },
    });

    subject.applyClaudeSettingsEnv();

    expect(assignmentOrder).toEqual([
      'ANTHROPIC_R6_FIRST',
      'CLAUDE_R6_SECOND',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'no_proxy',
      'all_proxy',
      'CLAUDE_R6_LAST',
    ]);
    expect(process.env.ANTHROPIC_R6_FIRST).toBe('first-secret');
    expect(process.env.HTTP_PROXY).toBe('HTTP_PROXY-value');
    expect(process.env.all_proxy).toBe('all_proxy-value');
    expect(process.env.CLAUDE_R6_LAST).toBe('last-secret');
    expect(mocks.readFileSync).toHaveBeenCalledWith(SETTINGS_PATH, 'utf8');
    expect(mocks.trackerObserveCount).toBe(1);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();
  });

  it.each([
    '{}',
    '{"env":null}',
    '{"env":"not-an-object"}',
    '{"env":{"ANTHROPIC_NON_STRING":42,"CLAUDE_NULL":null}}',
    'null',
  ])('treats a successful document with no valid env as healthy: %s', async (raw) => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue(raw);
    const subject = await freshSubject();

    expect(() => subject.applyClaudeSettingsEnv()).not.toThrow();
    expect(mocks.trackerObserveCount).toBe(1);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();
  });

  it('aggregates mixed keys after applying every allowed variable', async () => {
    setEnvDocument({
      RAW_REJECTED_FIRST: 'rejected-value-secret',
      ANTHROPIC_R6_ALLOWED: 'anthropic-secret',
      PATH: '/Users/private/evil',
      http_proxy: 'http://proxy.private/?token=secret',
      CLAUDE_NON_STRING: 42,
    });
    const subject = await freshSubject();

    subject.applyClaudeSettingsEnv();

    expect(process.env.ANTHROPIC_R6_ALLOWED).toBe('anthropic-secret');
    expect(process.env.http_proxy).toBe(
      'http://proxy.private/?token=secret',
    );
    expect(process.env.RAW_REJECTED_FIRST).toBeUndefined();
    expect(process.env.PATH).toBe(originalProcessEnv.PATH);
    expect(mocks.trackerObserveCount).toBe(1);
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Claude configuration state degraded',
      {
        event: 'claude-configuration-state',
        runId: 'settings-env-test-run',
        operation: 'settings-env',
        state: 'rejected-keys',
        previousState: null,
        transition: 'initial',
        abnormalDuration: 0,
        suppressedCount: 0,
        capped: false,
        summaryInterval: 300_000,
        appliedCount: 2,
        rejectedCount: 2,
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
        'appliedCount',
        'rejectedCount',
      ].sort(),
    );
    expect(loggedText()).not.toMatch(
      /RAW_REJECTED|ANTHROPIC_R6|PATH|proxy\.private|anthropic-secret|Users|token=secret|settings\.json/,
    );
  });

  it.each(['read', 'parse'] as const)(
    'classifies a %s failure without raw content',
    async (seam) => {
      mocks.existsSync.mockReturnValue(true);
      const rawError = new Error(
        'RAW_SETTINGS_ERROR token=secret /Users/private https://private.test',
      );
      rawError.name = 'PrivateSettingsError';
      if (seam === 'read') {
        mocks.readFileSync.mockImplementation(() => {
          throw rawError;
        });
      } else {
        mocks.readFileSync.mockReturnValue(
          '{"RAW_PARSE token=secret /Users/private":',
        );
      }
      const subject = await freshSubject();

      expect(() => subject.applyClaudeSettingsEnv()).not.toThrow();
      expect(mocks.trackerObserveCount).toBe(1);
      expect(diagnostic('warn')).toMatchObject({
        operation: 'settings-env',
        state: 'read-failed',
        appliedCount: 0,
        rejectedCount: 0,
      });
      expect(loggedText()).not.toMatch(
        /RAW_SETTINGS|RAW_PARSE|PrivateSettingsError|token=secret|Users|private\.test|settings\.json/,
      );
    },
  );

  it('preserves completed assignments and outer swallow behavior on an assignment failure', async () => {
    setEnvDocument({
      ANTHROPIC_R6_BEFORE: 'before',
      CLAUDE_R6_THROW: 'throw',
      HTTPS_PROXY: 'after',
    });
    const subject = await freshSubject();
    const assignmentOrder: string[] = [];
    process.env = new Proxy(process.env, {
      set(target, property, value) {
        assignmentOrder.push(String(property));
        if (property === 'CLAUDE_R6_THROW') {
          throw new Error('RAW_ASSIGNMENT_ERROR');
        }
        return Reflect.set(target, property, String(value));
      },
    });

    expect(() => subject.applyClaudeSettingsEnv()).not.toThrow();
    expect(assignmentOrder).toEqual([
      'ANTHROPIC_R6_BEFORE',
      'CLAUDE_R6_THROW',
    ]);
    expect(process.env.ANTHROPIC_R6_BEFORE).toBe('before');
    expect(process.env.HTTPS_PROXY).toBe(originalProcessEnv.HTTPS_PROXY);
    expect(diagnostic('warn')).toMatchObject({
      state: 'read-failed',
      appliedCount: 1,
      rejectedCount: 0,
    });
    expect(loggedText()).not.toContain('RAW_ASSIGNMENT_ERROR');
  });

  it('finishes later allowed assignments before a throwing diagnostic sink', async () => {
    setEnvDocument({
      RAW_REJECTED_FIRST: 'secret',
      ANTHROPIC_R6_AFTER: 'after',
      CLAUDE_R6_LAST: 'last',
    });
    const subject = await freshSubject();
    mocks.logger.warn.mockImplementation(() => {
      throw new Error('RAW_SINK');
    });

    expect(() => subject.applyClaudeSettingsEnv()).not.toThrow();
    expect(process.env.ANTHROPIC_R6_AFTER).toBe('after');
    expect(process.env.CLAUDE_R6_LAST).toBe('last');
    expect(mocks.trackerObserveCount).toBe(1);
  });

  it('summarizes repeats, transitions fixed failures, and recovers once', async () => {
    mocks.existsSync.mockReturnValue(true);
    let raw = '{"broken":';
    mocks.readFileSync.mockImplementation(() => raw);
    const subject = await freshSubject();

    subject.applyClaudeSettingsEnv();
    vi.setSystemTime(1);
    subject.applyClaudeSettingsEnv();
    expect(mocks.logger.warn).toHaveBeenCalledOnce();

    vi.setSystemTime(300_000);
    subject.applyClaudeSettingsEnv();
    expect(mocks.logger.warn).toHaveBeenLastCalledWith(
      'Claude configuration state remains degraded',
      expect.objectContaining({
        state: 'read-failed',
        previousState: 'read-failed',
        transition: 'periodic-summary',
        abnormalDuration: 300_000,
        suppressedCount: 1,
        capped: false,
      }),
    );

    raw = JSON.stringify({
      env: { RAW_REJECTED: 'secret', ANTHROPIC_R6_OK: 'ok' },
    });
    vi.setSystemTime(300_001);
    subject.applyClaudeSettingsEnv();
    expect(diagnostic('warn', 2)).toMatchObject({
      state: 'rejected-keys',
      previousState: 'read-failed',
      transition: 'transition',
    });

    raw = JSON.stringify({ env: { CLAUDE_R6_OK: 'healthy' } });
    vi.setSystemTime(300_002);
    subject.applyClaudeSettingsEnv();
    expect(mocks.logger.info).toHaveBeenCalledOnce();
    expect(diagnostic('info')).toMatchObject({
      state: 'healthy',
      previousState: 'rejected-keys',
      transition: 'transition',
    });
    subject.applyClaudeSettingsEnv();
    expect(mocks.logger.info).toHaveBeenCalledOnce();
  });

  it('bounds applied and rejected counts without truncating assignments', async () => {
    const env: Record<string, string> = {};
    for (let index = 0; index < 10_001; index += 1) {
      env[`RAW_REJECTED_${index}`] = 'rejected';
      env[`CLAUDE_R6_ALLOWED_${index}`] = `allowed-${index}`;
    }
    setEnvDocument(env);
    const subject = await freshSubject();

    subject.applyClaudeSettingsEnv();

    expect(process.env.CLAUDE_R6_ALLOWED_10000).toBe('allowed-10000');
    expect(diagnostic('warn')).toMatchObject({
      state: 'rejected-keys',
      appliedCount: 10_000,
      rejectedCount: 10_000,
    });
    expect(mocks.trackerObserveCount).toBe(1);
  });

  it('keeps existsSync exceptions outside the existing swallow boundary', async () => {
    const rawError = new Error('RAW_EXISTS_ERROR');
    mocks.existsSync.mockImplementation(() => {
      throw rawError;
    });
    const subject = await freshSubject();

    expect(() => subject.applyClaudeSettingsEnv()).toThrow(rawError);
    expect(mocks.trackerObserveCount).toBe(0);
  });

  it.each([
    'scope',
    'tracker-constructor',
    'tracker-observe',
    'serializer',
    'run-id',
    'sink',
    'clock',
  ] as const)(
    'contains a %s diagnostic failure without interrupting assignments',
    async (seam) => {
      setEnvDocument({
        RAW_REJECTED_FIRST: 'secret',
        ANTHROPIC_R6_AFTER: 'after',
        CLAUDE_R6_LAST: 'last',
      });
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

      expect(() => subject.applyClaudeSettingsEnv()).not.toThrow();
      expect(process.env.ANTHROPIC_R6_AFTER).toBe('after');
      expect(process.env.CLAUDE_R6_LAST).toBe('last');
      expect(mocks.trackerObserveCount).toBeLessThanOrEqual(1);
      expect(mocks.trackerOptions).toContainEqual(
        expect.objectContaining({ capacity: 1, summaryIntervalMs: 300_000 }),
      );
    },
  );
});
