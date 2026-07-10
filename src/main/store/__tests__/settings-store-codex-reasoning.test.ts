import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockRawStore: Record<string, unknown> = {};

const mockSet = vi.fn((key: string, value: unknown) => {
  mockRawStore[key] = value;
});
const mockGet = vi.fn((key: string) => mockRawStore[key]);
const mockHas = vi.fn((key: string) => key in mockRawStore);
const mockDelete = vi.fn((key: string) => {
  delete mockRawStore[key];
});

vi.mock('electron-store', () => ({
  default: class MockStore {
    constructor(opts?: { defaults?: Record<string, unknown> }) {
      if (!opts?.defaults) return;

      const fileStore = { ...mockRawStore };
      const needsWriteBack = Object.keys(opts.defaults).some((key) => !(key in fileStore));
      if (needsWriteBack) {
        mockRawStore = { ...opts.defaults, ...fileStore };
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
      return mockHas(key);
    }

    delete(key: string) {
      return mockDelete(key);
    }
  },
}));

beforeEach(() => {
  mockRawStore = {};
  vi.resetModules();
  mockSet.mockClear();
  mockGet.mockClear();
  mockHas.mockClear();
  mockDelete.mockClear();
});

async function loadSettingsStore() {
  const mod = await import('@main/store/settings-store');
  return mod.settingsStore;
}

describe('settings-store — Codex MAX preservation', () => {
  it('preserves retained Codex MAX values', async () => {
    mockRawStore = {
      summaryProvider: 'codex',
      summaryReasoning: 'max',
      handOffProvider: 'codex',
      handOffReasoning: 'max',
    };

    const all = (await loadSettingsStore()).getAll();

    expect(mockSet.mock.calls.filter((call) => call[0] === 'summaryReasoning')).toHaveLength(0);
    expect(mockSet.mock.calls.filter((call) => call[0] === 'handOffReasoning')).toHaveLength(0);
    expect(all.summaryReasoning).toBe('max');
    expect(all.handOffReasoning).toBe('max');
  });

  it('preserves Claude-family MAX values', async () => {
    mockRawStore = {
      summaryProvider: 'claude',
      summaryReasoning: 'max',
      handOffProvider: 'deepseek',
      handOffReasoning: 'max',
    };

    const all = (await loadSettingsStore()).getAll();

    expect(mockSet.mock.calls.filter((call) => call[0] === 'summaryReasoning')).toHaveLength(0);
    expect(mockSet.mock.calls.filter((call) => call[0] === 'handOffReasoning')).toHaveLength(0);
    expect(all.summaryReasoning).toBe('max');
    expect(all.handOffReasoning).toBe('max');
  });
});
