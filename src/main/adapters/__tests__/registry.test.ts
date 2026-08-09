import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AdapterContext } from '../types';
import type {
  BoundedLogStateTrackerOptions,
  LogStateObservation,
} from '@main/utils/log-state-tracker';

const mocks = vi.hoisted(() => ({
  diagnosticMode: 'normal' as 'normal' | 'throw',
  runIdMode: 'normal' as 'normal' | 'throw',
  scopeMode: 'normal' as 'normal' | 'throw',
  trackerMode: 'normal' as 'normal' | 'construct-throw' | 'observe-throw',
  trackerOptions: [] as BoundedLogStateTrackerOptions[],
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('@main/utils/logger', () => ({
  default: {
    scope: () => {
      if (mocks.scopeMode === 'throw') throw new Error('scope secret');
      return mocks.logger;
    },
  },
}));
vi.mock('@main/utils/run-context', () => ({
  getProcessRunId: () => {
    if (mocks.runIdMode === 'throw') throw new Error('run-id secret');
    return 'registry-test-run';
  },
}));
vi.mock('@main/utils/safe-diagnostic', () => ({
  safeDiagnostic: (value: unknown) => {
    if (mocks.diagnosticMode === 'throw') throw new Error('serializer secret');
    return value;
  },
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

const FAKE_CTX = {} as AdapterContext;
const SUMMARY_INTERVAL_MS = 300_000;
const INIT_THRESHOLD_MS = 10_000;
const SHUTDOWN_THRESHOLD_MS = 5_000;
const MAX_DIAGNOSTIC_COUNT = 10_000;
const DIAGNOSTIC_FIELDS =
  'abnormalDuration capped durationMs event failedCount maxDuration phase previousState runId state summaryInterval suppressedCount thresholdMs totalCount transition'
    .split(' ')
    .sort();
interface StubBehavior {
  init?: (ctx: AdapterContext) => void | Promise<void>;
  shutdown?: () => void | Promise<void>;
}
function makeStubAdapter(id: string, behavior: StubBehavior = {}): AgentAdapter {
  return {
    id,
    displayName: 'in-memory stub',
    capabilities: {} as AgentAdapter['capabilities'],
    init: vi.fn(async (ctx: AdapterContext) => behavior.init?.(ctx)),
    shutdown: vi.fn(async () => behavior.shutdown?.()),
  } as AgentAdapter;
}
async function makeRegistry() {
  vi.resetModules();
  const { createDesktopAdapterRegistry } = await import('../registry');
  return createDesktopAdapterRegistry();
}
function diagnostic(
  level: 'info' | 'warn',
  index = 0,
): Record<string, unknown> {
  return mocks.logger[level].mock.calls[index]?.[1] as Record<string, unknown>;
}
function allLoggerCalls(): string {
  return JSON.stringify(Object.values(mocks.logger).flatMap((fn) => fn.mock.calls));
}

beforeEach(() => {
  mocks.diagnosticMode = 'normal';
  mocks.runIdMode = 'normal';
  mocks.scopeMode = 'normal';
  mocks.trackerMode = 'normal';
  mocks.trackerOptions.length = 0;
  for (const method of Object.values(mocks.logger)) method.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('AdapterRegistryClass registry behavior', () => {
  it('preserves insertion order, object identity, lookup, and duplicate rejection', async () => {
    const registry = await makeRegistry();
    const first = makeStubAdapter('first');
    const second = makeStubAdapter('second');
    registry.register(first);
    registry.register(second);
    expect(registry.get('first')).toBe(first);
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.list()).toEqual([first, second]);
    expect(() => registry.register(makeStubAdapter('first'))).toThrow(
      'Adapter first already registered',
    );
  });

  it('returns empty results and keeps both initial healthy phases silent', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(0);
    const registry = await makeRegistry();
    await expect(registry.initAll(FAKE_CTX)).resolves.toEqual([]);
    await expect(registry.shutdownAll()).resolves.toEqual([]);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it('runs in order, continues after failures, and returns raw values unchanged', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const registry = await makeRegistry();
    const order: string[] = [];
    const initFailure = {
      message: 'INIT_SECRET /Users/private https://example.test/?token=secret',
    };
    const shutdownFailure = {
      message: 'SHUTDOWN_SECRET adapter-private-id',
    };
    const first = makeStubAdapter('adapter-private-id', {
      init: async (ctx) => {
        expect(ctx).toBe(FAKE_CTX);
        order.push('init:first');
        throw initFailure;
      },
      shutdown: async () => {
        order.push('shutdown:first');
      },
    });
    const second = makeStubAdapter('second-private-id', {
      init: async () => {
        order.push('init:second');
      },
      shutdown: async () => {
        order.push('shutdown:second');
        throw shutdownFailure;
      },
    });
    registry.register(first);
    registry.register(second);
    const initResults = await registry.initAll(FAKE_CTX);
    const shutdownResults = await registry.shutdownAll();
    expect(order).toEqual([
      'init:first',
      'init:second',
      'shutdown:first',
      'shutdown:second',
    ]);
    expect(initResults).toEqual([
      { id: 'adapter-private-id', ok: false, err: initFailure },
      { id: 'second-private-id', ok: true },
    ]);
    expect(shutdownResults).toEqual([
      { id: 'adapter-private-id', ok: true },
      { id: 'second-private-id', ok: false, err: shutdownFailure },
    ]);
    expect(initResults[0]?.err).toBe(initFailure);
    expect(shutdownResults[1]?.err).toBe(shutdownFailure);
    expect(registry.get('adapter-private-id')).toBe(first);
    expect(registry.list()).toEqual([first, second]);
    expect(mocks.logger.warn).toHaveBeenCalledTimes(2);
    expect(diagnostic('warn', 0)).toMatchObject({
      phase: 'init',
      state: 'partial-failure',
      totalCount: 2,
      failedCount: 1,
    });
    expect(diagnostic('warn', 1)).toMatchObject({
      phase: 'shutdown',
      state: 'partial-failure',
      totalCount: 2,
      failedCount: 1,
    });
    expect(Object.keys(diagnostic('warn', 0)).sort()).toEqual(DIAGNOSTIC_FIELDS);
    expect(allLoggerCalls()).not.toMatch(
      /INIT_SECRET|SHUTDOWN_SECRET|private-id|Users|example\.test|token=secret/,
    );
  });

  it('classifies a complete non-empty failure separately', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(10);
    const registry = await makeRegistry();
    const rawFailure = { message: 'raw failure secret' };
    for (const id of ['secret-alpha', 'secret-beta']) {
      registry.register(
        makeStubAdapter(id, {
          init: () => {
            throw rawFailure;
          },
        }),
      );
    }
    const results = await registry.initAll(FAKE_CTX);
    expect(results).toEqual([
      { id: 'secret-alpha', ok: false, err: rawFailure },
      { id: 'secret-beta', ok: false, err: rawFailure },
    ]);
    expect(diagnostic('warn')).toMatchObject({
      phase: 'init',
      state: 'failed',
      totalCount: 2,
      failedCount: 2,
    });
    expect(allLoggerCalls()).not.toMatch(/secret-alpha|secret-beta|raw failure/);
  });
});

describe('AdapterRegistryClass aggregate diagnostics', () => {
  it.each([
    ['init', INIT_THRESHOLD_MS - 1, false],
    ['init', INIT_THRESHOLD_MS, true],
    ['shutdown', SHUTDOWN_THRESHOLD_MS - 1, false],
    ['shutdown', SHUTDOWN_THRESHOLD_MS, true],
  ] as const)(
    'applies the exact %s slow boundary at %d ms',
    async (phase, durationMs, shouldWarn) => {
      let nowMs = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
      const registry = await makeRegistry();
      registry.register(
        makeStubAdapter('boundary-stub', {
          init: () => {
            if (phase === 'init') nowMs += durationMs;
          },
          shutdown: () => {
            if (phase === 'shutdown') nowMs += durationMs;
          },
        }),
      );
      if (phase === 'init') await registry.initAll(FAKE_CTX);
      else await registry.shutdownAll();
      expect(mocks.logger.warn).toHaveBeenCalledTimes(shouldWarn ? 1 : 0);
      if (shouldWarn) {
        expect(diagnostic('warn')).toMatchObject({
          phase,
          state: 'slow',
          durationMs,
          thresholdMs:
            phase === 'init' ? INIT_THRESHOLD_MS : SHUTDOWN_THRESHOLD_MS,
        });
      }
    },
  );

  it('summarizes repeats, transitions signatures, and recovers once', async () => {
    let nowMs = 0;
    let durationMs = INIT_THRESHOLD_MS;
    let failedCount = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const registry = await makeRegistry();
    for (const index of [0, 1]) {
      registry.register(
        makeStubAdapter(`stub-${index}`, {
          init: () => {
            if (index === 0) nowMs += durationMs;
            if (index < failedCount) throw new Error(`raw-${index}`);
          },
        }),
      );
    }
    await registry.initAll(FAKE_CTX);
    expect(diagnostic('warn')).toMatchObject({
      state: 'slow',
      transition: 'initial',
      durationMs: INIT_THRESHOLD_MS,
    });
    nowMs = 20_000;
    durationMs = 15_000;
    await registry.initAll(FAKE_CTX);
    expect(mocks.logger.warn).toHaveBeenCalledOnce();

    nowMs = 300_000;
    durationMs = INIT_THRESHOLD_MS;
    await registry.initAll(FAKE_CTX);
    expect(diagnostic('warn', 1)).toMatchObject({
      state: 'slow',
      transition: 'periodic-summary',
      abnormalDuration: SUMMARY_INTERVAL_MS,
      suppressedCount: 1,
      capped: false,
      maxDuration: 15_000,
    });
    nowMs = 320_000;
    durationMs = 20_000;
    failedCount = 1;
    await registry.initAll(FAKE_CTX);
    expect(diagnostic('warn', 2)).toMatchObject({
      state: 'partial-failure',
      previousState: 'slow',
      transition: 'transition',
      maxDuration: 20_000,
    });
    nowMs = 350_000;
    durationMs = 1;
    failedCount = 2;
    await registry.initAll(FAKE_CTX);
    expect(diagnostic('warn', 3)).toMatchObject({
      state: 'failed',
      previousState: 'partial-failure',
    });

    nowMs = 360_000;
    failedCount = 0;
    await registry.initAll(FAKE_CTX);
    expect(diagnostic('info')).toMatchObject({
      state: 'healthy',
      previousState: 'failed',
      transition: 'transition',
    });
    await registry.initAll(FAKE_CTX);
    expect(mocks.logger.info).toHaveBeenCalledOnce();
  });

  it('tracks init and shutdown independently with fixed tracker options', async () => {
    let initFails = true;
    let shutdownFails = true;
    vi.spyOn(Date, 'now').mockReturnValue(0);
    const registry = await makeRegistry();
    registry.register(
      makeStubAdapter('independent-stub', {
        init: () => {
          if (initFails) throw new Error('init secret');
        },
        shutdown: () => {
          if (shutdownFails) throw new Error('shutdown secret');
        },
      }),
    );
    await registry.initAll(FAKE_CTX);
    await registry.shutdownAll();
    expect(diagnostic('warn', 0).phase).toBe('init');
    expect(diagnostic('warn', 1).phase).toBe('shutdown');
    initFails = false;
    await registry.initAll(FAKE_CTX);
    expect(diagnostic('info', 0).phase).toBe('init');
    shutdownFails = false;
    await registry.shutdownAll();
    expect(diagnostic('info', 1).phase).toBe('shutdown');
    expect(mocks.trackerOptions.length).toBeGreaterThan(0);
    for (const options of mocks.trackerOptions) {
      expect(options).toMatchObject({
        capacity: 2,
        summaryIntervalMs: SUMMARY_INTERVAL_MS,
      });
    }
  });

  it('caps repeat suppression at the tracker default', async () => {
    let nowMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const registry = await makeRegistry();
    registry.register(
      makeStubAdapter('repeat-stub', {
        init: () => {
          throw new Error('repeat raw secret');
        },
      }),
    );
    await registry.initAll(FAKE_CTX);
    for (let index = 0; index < 10_000; index += 1) {
      await registry.initAll(FAKE_CTX);
    }
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
    nowMs = SUMMARY_INTERVAL_MS;
    await registry.initAll(FAKE_CTX);
    expect(diagnostic('warn', 1)).toMatchObject({
      transition: 'periodic-summary',
      suppressedCount: 9_999,
      capped: true,
    });
  });

  it('bounds emitted totals without truncating result arrays', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(0);
    const registry = await makeRegistry();
    const rawFailure = { message: 'count secret' };
    for (let index = 0; index < MAX_DIAGNOSTIC_COUNT + 1; index += 1) {
      registry.register(
        makeStubAdapter(`stub-${index}`, {
          init: () => {
            throw rawFailure;
          },
        }),
      );
    }
    const results = await registry.initAll(FAKE_CTX);
    expect(results).toHaveLength(MAX_DIAGNOSTIC_COUNT + 1);
    expect(results.at(-1)?.err).toBe(rawFailure);
    expect(diagnostic('warn')).toMatchObject({
      totalCount: MAX_DIAGNOSTIC_COUNT,
      failedCount: MAX_DIAGNOSTIC_COUNT,
    });
  });

  it.each(['throw', 'nonfinite', 'rollback'] as const)(
    'contains %s clock behavior without changing results',
    async (clockMode) => {
      let callCount = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        callCount += 1;
        if (clockMode === 'throw') throw new Error('clock secret');
        if (clockMode === 'nonfinite') return Number.NaN;
        return callCount === 1 ? 100 : 50;
      });
      const registry = await makeRegistry();
      registry.register(makeStubAdapter('clock-stub'));
      await expect(registry.initAll(FAKE_CTX)).resolves.toEqual([
        { id: 'clock-stub', ok: true },
      ]);
      expect(mocks.logger.warn).not.toHaveBeenCalled();
      expect(mocks.logger.info).not.toHaveBeenCalled();
    },
  );
});

describe('AdapterRegistryClass diagnostic containment', () => {
  it.each([
    'scope',
    'tracker-constructor',
    'tracker-observe',
    'serializer',
    'run-id',
    'sink',
  ] as const)(
    'contains a %s failure without changing results or continuation',
    async (failureMode) => {
      vi.spyOn(Date, 'now').mockReturnValue(0);
      if (failureMode === 'scope') mocks.scopeMode = 'throw';
      if (failureMode === 'tracker-constructor') {
        mocks.trackerMode = 'construct-throw';
      }
      const registry = await makeRegistry();
      if (failureMode === 'tracker-observe') {
        mocks.trackerMode = 'observe-throw';
      }
      if (failureMode === 'serializer') mocks.diagnosticMode = 'throw';
      if (failureMode === 'run-id') mocks.runIdMode = 'throw';
      if (failureMode === 'sink') {
        mocks.logger.warn.mockImplementation(() => {
          throw new Error('sink secret');
        });
      }
      const rawFailure = { message: 'returned raw secret' };
      const failed = makeStubAdapter('failed-stub', {
        init: () => {
          throw rawFailure;
        },
      });
      const healthy = makeStubAdapter('healthy-stub');
      registry.register(failed);
      registry.register(healthy);
      const results = await registry.initAll(FAKE_CTX);
      expect(results).toEqual([
        { id: 'failed-stub', ok: false, err: rawFailure },
        { id: 'healthy-stub', ok: true },
      ]);
      expect(results[0]?.err).toBe(rawFailure);
      expect(failed.init).toHaveBeenCalledOnce();
      expect(healthy.init).toHaveBeenCalledOnce();
    },
  );
});
