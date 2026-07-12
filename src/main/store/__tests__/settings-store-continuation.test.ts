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

  it('copies an old-only generator and removes the count plus legacy sentinel', async () => {
    mockRawStore = {
      handOffProvider: 'codex',
      handOffModel: 'gpt-continuation',
      handOffReasoning: 'ultra',
      resumeRecentMessagesCount: 77,
      __resumeRecentMessagesDefault20260710Done: true,
    };

    const all = (await loadSettingsStore()).getAll() as AppSettings & Record<string, unknown>;
    expect(all.continuationCheckpointProvider).toBe('codex');
    expect(all.continuationCheckpointModel).toBe('gpt-continuation');
    expect(all.continuationCheckpointThinking).toBe('ultra');
    expect(all.continuationRawRetentionTokens).toBe(64_000);
    expect(mockSet).toHaveBeenCalledWith('continuationCheckpointProvider', 'codex');
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
      continuationCheckpointProvider: 'deepseek',
      continuationCheckpointModel: 'deepseek-chat',
      continuationCheckpointThinking: 'max',
      continuationRawRetentionTokens: 96_000,
      handOffProvider: 'codex',
      handOffModel: 'ignored-old-model',
      handOffReasoning: 'ultra',
    };

    const all = (await loadSettingsStore()).getAll();
    expect(all).toMatchObject({
      continuationCheckpointProvider: 'deepseek',
      continuationCheckpointModel: 'deepseek-chat',
      continuationCheckpointThinking: 'max',
      continuationRawRetentionTokens: 96_000,
    });
    for (const key of [
      'continuationCheckpointProvider',
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
      continuationCheckpointProvider: 'unknown-provider',
      continuationCheckpointModel: 42,
      continuationCheckpointThinking: 'minimal',
      continuationRawRetentionTokens: Number.NaN,
      handOffProvider: 'codex',
      handOffModel: 'ignored-old-model',
      handOffReasoning: 'high',
    };

    const all = (await loadSettingsStore()).getAll();
    expect(all).toMatchObject({
      continuationCheckpointProvider: 'claude',
      continuationCheckpointModel: '',
      // New incompatible values are repaired, not legacy-coerced.
      continuationCheckpointThinking: 'high',
      continuationRawRetentionTokens: 64_000,
    });
    expect(mockSet).toHaveBeenCalledWith('continuationCheckpointProvider', 'claude');
    expect(mockSet).toHaveBeenCalledWith('continuationCheckpointModel', '');
    expect(mockSet).toHaveBeenCalledWith('continuationCheckpointThinking', 'high');
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

  it.each(['minimal', 'ultra'])('repairs new Claude-incompatible thinking %s', async (value) => {
    mockRawStore = {
      continuationCheckpointProvider: 'claude',
      continuationCheckpointThinking: value,
    };
    const all = (await loadSettingsStore()).getAll();
    expect(all.continuationCheckpointThinking).toBe('high');
    expect(mockSet).toHaveBeenCalledWith('continuationCheckpointThinking', 'high');
  });

  it('uplifts the exact old generator defaults once', async () => {
    mockRawStore = {
      summaryReasoning: 'low',
      continuationCheckpointThinking: 'medium',
    };

    const all = (await loadSettingsStore()).getAll();
    expect(all.summaryReasoning).toBe('medium');
    expect(all.continuationCheckpointThinking).toBe('high');
    expect(mockSet).toHaveBeenCalledWith('summaryReasoning', 'medium');
    expect(mockSet).toHaveBeenCalledWith('continuationCheckpointThinking', 'high');
    expect(mockSet).toHaveBeenCalledWith('__generatorDefaults20260711Done', true);
  });

  it('respects later user choices after the generator-default uplift sentinel is set', async () => {
    mockRawStore = {
      summaryReasoning: 'low',
      continuationCheckpointThinking: 'medium',
    };
    const first = await loadSettingsStore();
    first.set('summaryReasoning', 'low');
    first.set('continuationCheckpointThinking', 'medium');

    vi.resetModules();
    mockSet.mockClear();
    const all = (await loadSettingsStore()).getAll();
    expect(all.summaryReasoning).toBe('low');
    expect(all.continuationCheckpointThinking).toBe('medium');
    expect(callsFor('summaryReasoning')).toHaveLength(0);
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
      continuationCheckpointProvider: 'claude',
      continuationCheckpointModel: 'claude-sonnet',
      continuationCheckpointThinking: 'high',
    });
    expect(callsFor('continuationCheckpointProvider')).toHaveLength(0);
    expect(callsFor('continuationCheckpointModel')).toHaveLength(0);
    expect(callsFor('continuationCheckpointThinking')).toHaveLength(0);
    expect(mockDelete).not.toHaveBeenCalledWith('handOffProvider');
  });
});
