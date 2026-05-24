/**
 * settings-store smart migration 4 格断言（plan task-mcp-merge-into-agent-deck-mcp-20260521
 * §D2 R1 F11 + R2-claude-MED-2 修法 + Step 22 测试覆盖矩阵）。
 *
 * 验证 enableTaskManager → enableAgentDeckMcp smart migration 4 case：
 * - (1) raw enableTaskManager:true + raw 不含 enableAgentDeckMcp → enableAgentDeckMcp:true + warn + legacy key deleted
 * - (2) raw enableTaskManager:false + raw 不含 enableAgentDeckMcp → enableAgentDeckMcp 不动（保留 false default）+ legacy key deleted
 * - (3) raw 含 explicit enableAgentDeckMcp → migration skip（用户决策优先）+ legacy key deleted
 * - (4) raw 全空（fresh install）→ no-op + 不打 warn + 默认 OFF
 *
 * 测试策略：直接 import + mock electron-store, 用 in-memory Map 模拟 raw store。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// In-memory store 替代 electron-store
let mockRawStore: Record<string, unknown> = {};
const mockSet = vi.fn((key: string, value: unknown) => {
  mockRawStore[key] = value;
});
const mockGet = vi.fn((key: string) => mockRawStore[key]);
const mockHas = vi.fn((key: string) => key in mockRawStore);
const mockDelete = vi.fn((key: string) => {
  delete mockRawStore[key];
});

// mock electron-store 整个模块 — 让 settings-store.ts 拿到我们的 mock store
vi.mock('electron-store', () => ({
  default: class MockStore {
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

// 重置 settings-store 内部缓存的 store 实例，每次测试拿 fresh
beforeEach(async () => {
  mockRawStore = {};
  vi.resetModules();
  mockSet.mockClear();
  mockGet.mockClear();
  mockDelete.mockClear();
});

async function loadSettingsStore() {
  // dynamic import 让每 it 重新 evaluate settings-store.ts ensure()
  const mod = await import('@main/store/settings-store');
  return mod.settingsStore;
}

describe('settings-store smart migration — enableTaskManager → enableAgentDeckMcp (4 格)', () => {
  it('(1) legacy true + 无 explicit enableAgentDeckMcp → set enableAgentDeckMcp=true + warn + legacy deleted', async () => {
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockRawStore = { enableTaskManager: true };

    const settings = await loadSettingsStore();
    settings.getAll(); // 触发 ensure()

    // smart migration set enableAgentDeckMcp=true
    expect(mockSet).toHaveBeenCalledWith('enableAgentDeckMcp', true);
    // warn 日志
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('migrated enableTaskManager=true → enableAgentDeckMcp=true'),
    );
    // legacy key deleted
    expect(mockDelete).toHaveBeenCalledWith('enableTaskManager');
    warnSpy.mockRestore();
  });

  it('(2) legacy false + 无 explicit enableAgentDeckMcp → 不动 enableAgentDeckMcp + legacy deleted', async () => {
    mockRawStore = { enableTaskManager: false };
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const settings = await loadSettingsStore();
    settings.getAll();

    // migration 不 set enableAgentDeckMcp（保留 default false 不动）
    const setCalls = mockSet.mock.calls.filter((c) => c[0] === 'enableAgentDeckMcp');
    expect(setCalls).toHaveLength(0);
    // 不打 migration warn 日志
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('migrated enableTaskManager'),
    );
    // legacy key 仍被 REMOVED_KEYS delete
    expect(mockDelete).toHaveBeenCalledWith('enableTaskManager');
    warnSpy.mockRestore();
  });

  it('(3) raw 含 explicit enableAgentDeckMcp value → migration skip（用户决策优先）+ legacy deleted', async () => {
    mockRawStore = { enableTaskManager: true, enableAgentDeckMcp: false };
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const settings = await loadSettingsStore();
    settings.getAll();

    // migration 不覆盖用户 explicit false
    const enableSetCalls = mockSet.mock.calls.filter(
      (c) => c[0] === 'enableAgentDeckMcp',
    );
    expect(enableSetCalls).toHaveLength(0);
    // 不打 migration warn 日志
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('migrated enableTaskManager'),
    );
    // legacy key 仍 delete
    expect(mockDelete).toHaveBeenCalledWith('enableTaskManager');
    warnSpy.mockRestore();
  });

  it('(4) fresh install (raw 全空) → migration no-op + 不打 warn + 默认 OFF (load-bearing：新用户路径不该看 warn 噪音)', async () => {
    mockRawStore = {};
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const settings = await loadSettingsStore();
    settings.getAll();

    // 无 enableTaskManager 在 raw → migration 整段不进 if
    const enableSetCalls = mockSet.mock.calls.filter(
      (c) => c[0] === 'enableAgentDeckMcp',
    );
    expect(enableSetCalls).toHaveLength(0);
    // 不打 migration warn 日志（load-bearing：新用户不该看噪音）
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('migrated enableTaskManager'),
    );
    // REMOVED_KEYS delete loop 也不调（key 不在 raw）
    const deleteCalls = mockDelete.mock.calls.filter(
      (c) => c[0] === 'enableTaskManager',
    );
    expect(deleteCalls).toHaveLength(0);
    warnSpy.mockRestore();
  });
});
