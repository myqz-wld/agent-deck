import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/types';

let persisted: Record<string, unknown> = {};
let constructorDefaults: Record<string, unknown> | undefined;
const set = vi.fn((key: string, value: unknown) => {
  persisted[key] = value;
});

vi.mock('electron-store', () => ({
  default: class MockStore {
    constructor(options?: { defaults?: Record<string, unknown> }) {
      constructorDefaults = options?.defaults;
      persisted = { ...(options?.defaults ?? {}), ...persisted };
    }

    get store() {
      return persisted;
    }

    get(key: string) {
      return persisted[key];
    }

    set(key: string, value: unknown) {
      set(key, value);
    }
  },
}));

beforeEach(() => {
  persisted = {};
  constructorDefaults = undefined;
  set.mockClear();
  vi.resetModules();
});

async function loadSettingsStore() {
  return (await import('@main/store/settings-store')).settingsStore;
}

describe('settings-store current schema', () => {
  it('uses an isolated copy of the current defaults', async () => {
    const all = (await loadSettingsStore()).getAll();
    expect(constructorDefaults).not.toBe(DEFAULT_SETTINGS);
    const {
      hookServerToken: _hookServerToken,
      mcpServerToken: _mcpServerToken,
      ...ordinaryDefaults
    } = DEFAULT_SETTINGS;
    expect(all).toMatchObject(ordinaryDefaults);
    expect(all.hookServerToken).toMatch(/^[0-9a-f]{64}$/);
    expect(all.mcpServerToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns only current settings keys', async () => {
    persisted = {
      windowTransparent: false,
      summaryTimeoutMs: 1,
    };
    const all = await (await loadSettingsStore()).getAll();
    expect(all.windowTransparent).toBe(false);
    expect(all).not.toHaveProperty('summaryTimeoutMs');
  });

  it('replaces malformed security tokens', async () => {
    persisted = {
      hookServerToken: 'x'.repeat(64),
      mcpServerToken: null,
    };
    const all = await (await loadSettingsStore()).getAll();
    expect(all.hookServerToken).toMatch(/^[0-9a-f]{64}$/);
    expect(all.mcpServerToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps canonical security tokens stable', async () => {
    const hook = 'a'.repeat(64);
    const mcp = 'b'.repeat(64);
    persisted = { hookServerToken: hook, mcpServerToken: mcp };
    const all = await (await loadSettingsStore()).getAll();
    expect(all.hookServerToken).toBe(hook);
    expect(all.mcpServerToken).toBe(mcp);
    expect(set).not.toHaveBeenCalled();
  });

  it('patches current values', async () => {
    const settings = await loadSettingsStore();
    const next = settings.patch({ windowTransparent: false });
    expect(next.windowTransparent).toBe(false);
    expect(set).toHaveBeenCalledWith('windowTransparent', false);
  });
});
