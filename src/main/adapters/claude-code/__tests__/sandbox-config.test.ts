import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BoundedLogStateTrackerOptions,
  LogStateObservation,
} from '@main/utils/log-state-tracker';
import type { SandboxMode } from '../sandbox-config';

const mocks = vi.hoisted(() => ({
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

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => '/Users/config-home',
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

type Subject = typeof import('../sandbox-config');

const EXCLUDED_COMMANDS = [
  'git',
  'pnpm',
  'npm',
  'yarn',
  'bun',
  'pip',
  'pip3',
  'cargo',
  'go',
  'docker',
  'watchman',
  'orb',
  'lima',
  'colima',
  'make',
  'xcodebuild',
];
const DENY_READ = [
  '/Users/config-home/.ssh',
  '/Users/config-home/.aws',
  '/Users/config-home/.config',
  '/Users/config-home/.kube',
  '/Users/config-home/.npmrc',
  '/Users/config-home/.netrc',
  '/Users/config-home/.pypirc',
  '/Users/config-home/.gnupg',
  '/Users/config-home/.docker',
  '/Users/config-home/.zsh_history',
  '/Users/config-home/.bash_history',
  '/Users/config-home/Library/Keychains',
  '/Users/config-home/Library/Cookies',
];

async function freshSubject(): Promise<Subject> {
  vi.resetModules();
  return import('../sandbox-config');
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
  mocks.getProcessRunId.mockReturnValue('sandbox-test-run');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Claude sandbox configuration', () => {
  it('keeps the public mode and excluded-command lists exact', async () => {
    const subject = await freshSubject();

    expect(subject.SANDBOX_MODE_VALUES).toEqual([
      'off',
      'workspace-write',
      'strict',
    ]);
    expect(subject.SANDBOX_EXCLUDED_COMMANDS).toEqual(EXCLUDED_COMMANDS);
    expect(subject.SANDBOX_EXCLUDED_COMMANDS).not.toContain('node');
    expect(subject.SANDBOX_EXCLUDED_COMMANDS).not.toContain('npx');
    expect(subject.SANDBOX_EXCLUDED_COMMANDS).not.toContain('brew');
  });

  it.each([undefined, 'off'] as const)(
    'returns an empty object and records healthy silently for %s',
    async (mode) => {
      const subject = await freshSubject();

      expect(
        subject.buildSandboxOptions(mode, '/Users/private/project'),
      ).toEqual({});
      expect(mocks.logger.warn).not.toHaveBeenCalled();
      expect(mocks.logger.info).not.toHaveBeenCalled();
      expect(mocks.trackerOptions).toContainEqual(
        expect.objectContaining({ capacity: 1, summaryIntervalMs: 300_000 }),
      );
    },
  );

  it('returns the exact workspace-write object with ordered deduplication', async () => {
    const subject = await freshSubject();
    const cwd = '/Users/private/worktree';
    const result = subject.buildSandboxOptions('workspace-write', cwd, [
      cwd,
      '',
      '/Users/private/main',
      '/Users/private/main',
      '/Volumes/private/extra',
    ]);

    expect(result).toEqual({
      sandbox: {
        enabled: true,
        failIfUnavailable: false,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: true,
        excludedCommands: EXCLUDED_COMMANDS,
        filesystem: {
          allowWrite: [
            cwd,
            '/Users/private/main',
            '/Volumes/private/extra',
            '/tmp',
            '/Users/config-home/.cache/claude-code',
          ],
          denyRead: DENY_READ,
        },
      },
    });
    expect(result.sandbox?.excludedCommands).not.toBe(
      subject.SANDBOX_EXCLUDED_COMMANDS,
    );
    expect(result.sandbox?.network).toBeUndefined();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();
  });

  it('returns the exact strict object and ignores writable roots', async () => {
    const subject = await freshSubject();
    const result = subject.buildSandboxOptions(
      'strict',
      '/Users/private/worktree',
      ['/Users/private/main', '/Volumes/private/extra'],
    );

    expect(result).toEqual({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        excludedCommands: EXCLUDED_COMMANDS,
        filesystem: { denyRead: DENY_READ },
      },
    });
    expect(result.sandbox?.filesystem?.allowWrite).toBeUndefined();
    expect(result.sandbox?.network).toBeUndefined();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();
  });

  it('collapses hostile unknown modes to a fixed invalid state', async () => {
    const hostileMode = {
      toString: () => {
        throw new Error('RAW_MODE_TO_STRING');
      },
      raw: 'RAW_MODE token=secret /Users/private https://private.test',
    } as unknown as SandboxMode;
    const subject = await freshSubject();

    expect(
      subject.buildSandboxOptions(hostileMode, '/Users/private/project'),
    ).toEqual({});
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Claude configuration state degraded',
      {
        event: 'claude-configuration-state',
        runId: 'sandbox-test-run',
        operation: 'sandbox',
        state: 'invalid-mode',
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
      /RAW_MODE|token=secret|Users|private\.test|project/,
    );
  });

  it('suppresses invalid repeats, summarizes at five minutes, and recovers once', async () => {
    const subject = await freshSubject();
    const invalid = 'RAW_UNKNOWN_MODE' as unknown as SandboxMode;

    subject.buildSandboxOptions(invalid, '/private/cwd');
    vi.setSystemTime(1);
    subject.buildSandboxOptions('ANOTHER_RAW_MODE' as SandboxMode, '/private/cwd');
    expect(mocks.logger.warn).toHaveBeenCalledOnce();

    vi.setSystemTime(300_000);
    subject.buildSandboxOptions(invalid, '/private/cwd');
    expect(mocks.logger.warn).toHaveBeenLastCalledWith(
      'Claude configuration state remains degraded',
      expect.objectContaining({
        state: 'invalid-mode',
        previousState: 'invalid-mode',
        transition: 'periodic-summary',
        abnormalDuration: 300_000,
        suppressedCount: 1,
        capped: false,
      }),
    );

    vi.setSystemTime(300_001);
    expect(subject.buildSandboxOptions('off', '/private/cwd')).toEqual({});
    expect(mocks.logger.info).toHaveBeenCalledOnce();
    expect(diagnostic('info')).toMatchObject({
      state: 'healthy',
      previousState: 'invalid-mode',
      transition: 'transition',
    });
    subject.buildSandboxOptions(undefined, '/private/cwd');
    expect(mocks.logger.info).toHaveBeenCalledOnce();
    expect(loggedText()).not.toMatch(/RAW_UNKNOWN_MODE|ANOTHER_RAW_MODE/);
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
    'contains a %s diagnostic failure and preserves invalid fallback',
    async (seam) => {
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

      expect(
        subject.buildSandboxOptions(
          'RAW_INVALID' as SandboxMode,
          '/Users/private/cwd',
          ['/Users/private/extra'],
        ),
      ).toEqual({});
    },
  );
});
