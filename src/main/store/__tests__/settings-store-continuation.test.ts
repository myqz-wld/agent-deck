import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types';

let mockRawStore: Record<string, unknown> = {};
let constructorDefaults: Record<string, unknown> | undefined;
const mockSet = vi.fn((key: string, value: unknown) => {
  mockRawStore[key] = value;
});
const mockGet = vi.fn((key: string) => mockRawStore[key]);
const mockDelete = vi.fn((key: string) => {
  delete mockRawStore[key];
});

vi.mock('electron-store', () => ({
  default: class MockStore {
    constructor(opts?: { defaults?: Record<string, unknown> }) {
      if (!opts?.defaults) return;
      constructorDefaults = opts.defaults;
      const persisted = { ...mockRawStore };
      if (Object.keys(opts.defaults).some((key) => !(key in persisted))) {
        mockRawStore = { ...opts.defaults, ...persisted };
      }
    }
    get store() {
      return mockRawStore;
    }
    get(key: string) {
      return mockGet(key);
    }
    set(key: string, value: unknown) {
      return mockSet(key, value);
    }
    has(key: string) {
      return key in mockRawStore;
    }
    delete(key: string) {
      return mockDelete(key);
    }
  },
}));

beforeEach(() => {
  mockRawStore = {};
  constructorDefaults = undefined;
  vi.resetModules();
  mockSet.mockClear();
  mockGet.mockClear();
  mockDelete.mockClear();
});

async function loadSettingsStore() {
  return (await import('@main/store/settings-store')).settingsStore;
}

describe('unified continuation settings migration', () => {
  const callsFor = (key: string) => mockSet.mock.calls.filter((call) => call[0] === key);

  it('gives electron-store a copy instead of the shared defaults object', async () => {
    (await loadSettingsStore()).getAll();
    expect(constructorDefaults).toBeDefined();
    expect(constructorDefaults).not.toBe(DEFAULT_SETTINGS);
    expect(constructorDefaults).toMatchObject(DEFAULT_SETTINGS);
  });

  it('uses the new-install automation and generator defaults without materializing legacy models', async () => {
    const all = (await loadSettingsStore()).getAll();
    expect(all).toMatchObject({
      summaryEnabled: true,
      summaryAdapter: 'claude-code',
      summaryRuntimeProvider: '',
      summaryModel: '',
      summaryThinking: 'low',
      continuationCheckpointAdapter: 'claude-code',
      continuationCheckpointRuntimeProvider: '',
      continuationCheckpointModel: '',
      continuationCheckpointThinking: 'medium',
      continuationCheckpointAutoRefreshEnabled: true,
      continuationCheckpointAutoRefreshIntervalMinutes: 30,
      continuationCheckpointMaxConcurrent: 2,
    });
    expect(mockRawStore.__generatorBlankFallbacks20260714Done).toBe(true);
    expect(callsFor('summaryModel')).toHaveLength(0);
    expect(callsFor('continuationCheckpointModel')).toHaveLength(0);
  });

  it('materializes only the remaining existing blank-model fallback whose meaning changed', async () => {
    mockRawStore = {
      summaryProvider: 'deepseek',
      summaryModel: '',
      summaryThinking: 'xhigh',
      continuationCheckpointProvider: 'claude',
      continuationCheckpointModel: '',
      continuationCheckpointThinking: 'low',
      __generatorDefaults20260711Done: true,
    };

    const all = (await loadSettingsStore()).getAll();
    expect(all).toMatchObject({
      summaryModel: '',
      summaryThinking: 'xhigh',
      continuationCheckpointModel: 'opus',
      continuationCheckpointThinking: 'low',
    });
    expect(callsFor('summaryModel')).toHaveLength(0);
    expect(mockSet).toHaveBeenCalledWith('continuationCheckpointModel', 'opus');
    expect(callsFor('summaryThinking')).toHaveLength(0);
    expect(callsFor('continuationCheckpointThinking')).toHaveLength(0);
  });

  it('keeps a missing summary model blank while preserving the old continuation fallback', async () => {
    mockRawStore = {
      summaryProvider: 'deepseek',
      summaryThinking: 'high',
      __generatorDefaults20260711Done: true,
    };

    const all = (await loadSettingsStore()).getAll();
    expect(all.summaryModel).toBe('');
    expect(all.continuationCheckpointAdapter).toBe('claude-code');
    expect(all.continuationCheckpointModel).toBe('opus');
    expect(callsFor('summaryModel')).toHaveLength(0);
    expect(mockSet).toHaveBeenCalledWith('continuationCheckpointModel', 'opus');
  });

  it('uses the old Claude defaults when provider keys are also missing', async () => {
    mockRawStore = {
      activeWindowMs: DEFAULT_SETTINGS.activeWindowMs,
      __generatorDefaults20260711Done: true,
    };

    const all = (await loadSettingsStore()).getAll();
    expect(all.continuationCheckpointModel).toBe('opus');
    expect(all.summaryModel).toBe('');
    expect(mockSet).toHaveBeenCalledWith('continuationCheckpointModel', 'opus');
    expect(callsFor('summaryModel')).toHaveLength(0);
  });

  it('leaves Codex blanks, explicit models, and unchanged-provider blanks untouched', async () => {
    mockRawStore = {
      summaryProvider: 'claude',
      summaryModel: '',
      continuationCheckpointProvider: 'codex',
      continuationCheckpointModel: '',
      __generatorDefaults20260711Done: true,
    };
    let all = (await loadSettingsStore()).getAll();
    expect(all.summaryModel).toBe('');
    expect(all.continuationCheckpointModel).toBe('');
    expect(callsFor('summaryModel')).toHaveLength(0);
    expect(callsFor('continuationCheckpointModel')).toHaveLength(0);

    vi.resetModules();
    mockSet.mockClear();
    mockRawStore.summaryProvider = 'deepseek';
    mockRawStore.summaryModel = 'deepseek-explicit';
    mockRawStore.continuationCheckpointProvider = 'claude';
    mockRawStore.continuationCheckpointModel = 'claude-explicit';
    delete mockRawStore.__generatorBlankFallbacks20260714Done;
    all = (await loadSettingsStore()).getAll();
    expect(all.summaryModel).toBe('deepseek-explicit');
    expect(all.continuationCheckpointModel).toBe('claude-explicit');
    expect(callsFor('summaryModel')).toHaveLength(0);
    expect(callsFor('continuationCheckpointModel')).toHaveLength(0);
  });

  it('runs the blank-fallback migration once and preserves later user-cleared blanks', async () => {
    mockRawStore = {
      summaryProvider: 'deepseek',
      summaryModel: '',
      continuationCheckpointProvider: 'claude',
      continuationCheckpointModel: '',
      __generatorDefaults20260711Done: true,
    };
    const first = await loadSettingsStore();
    first.getAll();
    first.set('summaryModel', '');
    first.set('continuationCheckpointModel', '');

    vi.resetModules();
    mockSet.mockClear();
    const all = (await loadSettingsStore()).getAll();
    expect(all.summaryModel).toBe('');
    expect(all.continuationCheckpointModel).toBe('');
    expect(callsFor('summaryModel')).toHaveLength(0);
    expect(callsFor('continuationCheckpointModel')).toHaveLength(0);
  });

  it.each([4, 1_441, 30.5, Number.NaN])(
    'repairs invalid automatic checkpoint interval %s',
    async (value) => {
      mockRawStore = { continuationCheckpointAutoRefreshIntervalMinutes: value };
      const all = (await loadSettingsStore()).getAll();
      expect(all.continuationCheckpointAutoRefreshIntervalMinutes).toBe(30);
      expect(mockSet).toHaveBeenCalledWith(
        'continuationCheckpointAutoRefreshIntervalMinutes',
        30,
      );
    },
  );

  it.each([5, 1_440])('preserves valid automatic checkpoint interval %s', async (value) => {
    mockRawStore = { continuationCheckpointAutoRefreshIntervalMinutes: value };
    const all = (await loadSettingsStore()).getAll();
    expect(all.continuationCheckpointAutoRefreshIntervalMinutes).toBe(value);
    expect(callsFor('continuationCheckpointAutoRefreshIntervalMinutes')).toHaveLength(0);
  });

  it.each([0, 11, 2.5, Number.NaN])(
    'repairs invalid checkpoint concurrency %s',
    async (value) => {
      mockRawStore = { continuationCheckpointMaxConcurrent: value };
      const all = (await loadSettingsStore()).getAll();
      expect(all.continuationCheckpointMaxConcurrent).toBe(2);
      expect(mockSet).toHaveBeenCalledWith('continuationCheckpointMaxConcurrent', 2);
    },
  );

  it.each([1, 10])('preserves valid checkpoint concurrency %s', async (value) => {
    mockRawStore = { continuationCheckpointMaxConcurrent: value };
    const all = (await loadSettingsStore()).getAll();
    expect(all.continuationCheckpointMaxConcurrent).toBe(value);
    expect(callsFor('continuationCheckpointMaxConcurrent')).toHaveLength(0);
  });

  it('repairs malformed automation switches but preserves valid explicit off values', async () => {
    mockRawStore = {
      summaryEnabled: 'yes',
      continuationCheckpointAutoRefreshEnabled: 1,
    };
    let all = (await loadSettingsStore()).getAll();
    expect(all.summaryEnabled).toBe(true);
    expect(all.continuationCheckpointAutoRefreshEnabled).toBe(true);

    vi.resetModules();
    mockSet.mockClear();
    mockRawStore.summaryEnabled = false;
    mockRawStore.continuationCheckpointAutoRefreshEnabled = false;
    all = (await loadSettingsStore()).getAll();
    expect(all.summaryEnabled).toBe(false);
    expect(all.continuationCheckpointAutoRefreshEnabled).toBe(false);
    expect(callsFor('summaryEnabled')).toHaveLength(0);
    expect(callsFor('continuationCheckpointAutoRefreshEnabled')).toHaveLength(0);
  });

  it('copies an old-only generator and removes the count plus legacy sentinel', async () => {
    mockRawStore = {
      handOffProvider: 'codex',
      handOffModel: 'gpt-continuation',
      handOffReasoning: 'ultra',
      resumeRecentMessagesCount: 77,
      __resumeRecentMessagesDefault20260710Done: true,
    };

    const all = (await loadSettingsStore()).getAll() as AppSettings & Record<string, unknown>;
    expect(all.continuationCheckpointAdapter).toBe('codex-cli');
    expect(all.continuationCheckpointRuntimeProvider).toBe('');
    expect(all.continuationCheckpointModel).toBe('gpt-continuation');
    expect(all.continuationCheckpointThinking).toBe('ultra');
    expect(all.continuationRawRetentionTokens).toBe(64_000);
    expect(mockSet).toHaveBeenCalledWith('continuationCheckpointAdapter', 'codex-cli');
    expect(mockSet).toHaveBeenCalledWith('continuationCheckpointRuntimeProvider', '');
    expect(mockSet).toHaveBeenCalledWith('continuationCheckpointModel', 'gpt-continuation');
    expect(mockSet).toHaveBeenCalledWith('continuationCheckpointThinking', 'ultra');
    for (const key of [
      'handOffProvider',
      'handOffModel',
      'handOffReasoning',
      'resumeRecentMessagesCount',
      '__resumeRecentMessagesDefault20260710Done',
    ]) {
      expect(mockDelete).toHaveBeenCalledWith(key);
      expect(key in all).toBe(false);
    }
  });

  it('lets explicitly persisted new keys win and only removes old keys', async () => {
    mockRawStore = {
      continuationCheckpointAdapter: 'claude-code',
      continuationCheckpointRuntimeProvider: 'deepseek',
      continuationCheckpointModel: 'deepseek-chat',
      continuationCheckpointThinking: 'max',
      continuationRawRetentionTokens: 96_000,
      handOffProvider: 'codex',
      handOffModel: 'ignored-old-model',
      handOffReasoning: 'ultra',
    };

    const all = (await loadSettingsStore()).getAll();
    expect(all).toMatchObject({
      continuationCheckpointAdapter: 'claude-code',
      continuationCheckpointRuntimeProvider: 'deepseek',
      continuationCheckpointModel: 'deepseek-chat',
      continuationCheckpointThinking: 'max',
      continuationRawRetentionTokens: 96_000,
    });
    for (const key of [
      'continuationCheckpointAdapter',
      'continuationCheckpointRuntimeProvider',
      'continuationCheckpointModel',
      'continuationCheckpointThinking',
      'continuationRawRetentionTokens',
    ]) {
      expect(callsFor(key)).toHaveLength(0);
    }
    expect(mockDelete).toHaveBeenCalledWith('handOffProvider');
    expect(mockDelete).toHaveBeenCalledWith('handOffModel');
    expect(mockDelete).toHaveBeenCalledWith('handOffReasoning');
  });

  it('repairs invalid new values without consulting valid legacy fallbacks', async () => {
    mockRawStore = {
      continuationCheckpointAdapter: 'unknown-adapter',
      continuationCheckpointRuntimeProvider: 42,
      continuationCheckpointModel: 42,
      continuationCheckpointThinking: 'minimal',
      continuationRawRetentionTokens: Number.NaN,
      handOffProvider: 'codex',
      handOffModel: 'ignored-old-model',
      handOffReasoning: 'high',
    };

    const all = (await loadSettingsStore()).getAll();
    expect(all).toMatchObject({
      continuationCheckpointAdapter: 'claude-code',
      continuationCheckpointRuntimeProvider: '',
      continuationCheckpointModel: '',
      // Removed Codex minimal always migrates to its nearest supported value, even when the
      // persisted provider is invalid and falls back to Claude.
      continuationCheckpointThinking: 'low',
      continuationRawRetentionTokens: 64_000,
    });
    expect(mockSet).toHaveBeenCalledWith(
      'continuationCheckpointAdapter',
      'claude-code',
    );
    expect(mockSet).toHaveBeenCalledWith(
      'continuationCheckpointRuntimeProvider',
      '',
    );
    expect(mockSet).toHaveBeenCalledWith('continuationCheckpointModel', '');
    expect(mockSet).toHaveBeenCalledWith('continuationCheckpointThinking', 'low');
    expect(mockSet).toHaveBeenCalledWith('continuationRawRetentionTokens', 64_000);
  });

  it.each([7_999, 128_001, 64_000.5])('repairs invalid raw token value %s', async (value) => {
    mockRawStore = { continuationRawRetentionTokens: value };
    const all = (await loadSettingsStore()).getAll();
    expect(all.continuationRawRetentionTokens).toBe(64_000);
    expect(mockSet).toHaveBeenCalledWith('continuationRawRetentionTokens', 64_000);
  });

  it.each([42, 'm'.repeat(257)])('repairs invalid persisted model %s', async (value) => {
    mockRawStore = { continuationCheckpointModel: value };
    const all = (await loadSettingsStore()).getAll();
    expect(all.continuationCheckpointModel).toBe('');
    expect(mockSet).toHaveBeenCalledWith('continuationCheckpointModel', '');
  });

  it.each([42, 'm'.repeat(257)])('repairs invalid persisted summary model %s', async (value) => {
    mockRawStore = {
      summaryProvider: 'claude',
      summaryModel: value,
      __generatorBlankFallbacks20260714Done: true,
    };
    const all = (await loadSettingsStore()).getAll();
    expect(all.summaryModel).toBe('');
    expect(mockSet).toHaveBeenCalledWith('summaryModel', '');
  });

  it.each(['ultra', 'bogus'])('repairs new Claude-incompatible thinking %s', async (value) => {
    mockRawStore = {
      continuationCheckpointProvider: 'claude',
      continuationCheckpointThinking: value,
    };
    const all = (await loadSettingsStore()).getAll();
    expect(all.continuationCheckpointThinking).toBe('medium');
    expect(mockSet).toHaveBeenCalledWith('continuationCheckpointThinking', 'medium');
  });

  it('preserves Grok xhigh and coerces stale higher tiers to its supported ceiling', async () => {
    mockRawStore = {
      continuationCheckpointProvider: 'grok',
      continuationCheckpointThinking: 'xhigh',
    };
    let all = (await loadSettingsStore()).getAll();
    expect(all.continuationCheckpointAdapter).toBe('grok-build');
    expect(all.continuationCheckpointThinking).toBe('xhigh');

    vi.resetModules();
    mockSet.mockClear();
    mockRawStore.continuationCheckpointThinking = 'ultra';
    all = (await loadSettingsStore()).getAll();
    expect(all.continuationCheckpointThinking).toBe('xhigh');
    expect(mockSet).toHaveBeenCalledWith('continuationCheckpointThinking', 'xhigh');
  });

  it('coerces persisted removed Codex minimal generator settings to low', async () => {
    mockRawStore = {
      summaryProvider: 'codex',
      summaryThinking: 'minimal',
      continuationCheckpointProvider: 'codex',
      continuationCheckpointThinking: 'minimal',
    };

    const all = (await loadSettingsStore()).getAll();
    expect(all.summaryThinking).toBe('low');
    expect(all.continuationCheckpointThinking).toBe('low');
    expect(mockSet).toHaveBeenCalledWith('summaryThinking', 'low');
    expect(mockSet).toHaveBeenCalledWith('continuationCheckpointThinking', 'low');
  });

  it('retires the obsolete generator-default uplift without rewriting valid choices', async () => {
    mockRawStore = {
      summaryThinking: 'low',
      continuationCheckpointThinking: 'medium',
    };

    const all = (await loadSettingsStore()).getAll();
    expect(all.summaryThinking).toBe('low');
    expect(all.continuationCheckpointThinking).toBe('medium');
    expect(callsFor('summaryThinking')).toHaveLength(0);
    expect(callsFor('continuationCheckpointThinking')).toHaveLength(0);
    expect(mockSet).toHaveBeenCalledWith('__generatorDefaults20260711Done', true);
  });

  it('respects later user choices after the generator-default uplift sentinel is set', async () => {
    mockRawStore = {
      summaryThinking: 'low',
      continuationCheckpointThinking: 'medium',
    };
    const first = await loadSettingsStore();
    first.set('summaryThinking', 'low');
    first.set('continuationCheckpointThinking', 'medium');

    vi.resetModules();
    mockSet.mockClear();
    const all = (await loadSettingsStore()).getAll();
    expect(all.summaryThinking).toBe('low');
    expect(all.continuationCheckpointThinking).toBe('medium');
    expect(callsFor('summaryThinking')).toHaveLength(0);
    expect(callsFor('continuationCheckpointThinking')).toHaveLength(0);
  });

  it.each([
    ['minimal', 'low'],
    ['ultra', 'max'],
  ] as const)('coerces legacy Claude-family thinking %s to %s', async (legacy, expected) => {
    mockRawStore = { handOffProvider: 'deepseek', handOffReasoning: legacy };
    const all = (await loadSettingsStore()).getAll();
    expect(all.continuationCheckpointThinking).toBe(expected);
    expect(mockSet).toHaveBeenCalledWith('continuationCheckpointThinking', expected);
  });

  it('persists migration so a restart does not migrate again', async () => {
    mockRawStore = {
      handOffProvider: 'claude',
      handOffModel: 'claude-sonnet',
      handOffReasoning: 'high',
    };
    (await loadSettingsStore()).getAll();

    vi.resetModules();
    mockSet.mockClear();
    mockDelete.mockClear();
    const all = (await loadSettingsStore()).getAll();
    expect(all).toMatchObject({
      continuationCheckpointAdapter: 'claude-code',
      continuationCheckpointRuntimeProvider: '',
      continuationCheckpointModel: 'claude-sonnet',
      continuationCheckpointThinking: 'high',
    });
    expect(callsFor('continuationCheckpointAdapter')).toHaveLength(0);
    expect(callsFor('continuationCheckpointRuntimeProvider')).toHaveLength(0);
    expect(callsFor('continuationCheckpointModel')).toHaveLength(0);
    expect(callsFor('continuationCheckpointThinking')).toHaveLength(0);
    expect(mockDelete).not.toHaveBeenCalledWith('handOffProvider');
  });
});
