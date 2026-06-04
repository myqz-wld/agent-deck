/**
 * settings-store smart migration 4 格断言（plan task-mcp-merge-into-agent-deck-mcp-20260521
 * §D2 R1 F11 + R2-claude-MED-2 修法 + Step 22 测试覆盖矩阵）。
 *
 * 验证 enableTaskManager → enableAgentDeckMcp smart migration 4 case：
 * - (1) raw enableTaskManager:true + raw 不含 enableAgentDeckMcp → enableAgentDeckMcp:true + warn + legacy key deleted
 * - (2) raw enableTaskManager:false + raw 不含 enableAgentDeckMcp → enableAgentDeckMcp:false + legacy key deleted
 * - (3) raw 含 explicit enableAgentDeckMcp → migration skip（用户决策优先）+ legacy key deleted
 * - (4) raw 全空（fresh install）→ no-op + 不打 warn + 默认 ON
 *
 * F1 fix (deep-review-changelog146-20260524 R1 codex MED) regression case (5):
 * 模拟 conf@10.2.0 真实行为 — 构造时把 defaults `Object.assign({}, defaults, fileStore)` merged
 * 写回 fs（仅 first Store 实例触发，probe Store 无 defaults 不触发）。验证 fix 后 settings-store.ts
 * 用独立 probe Store snapshot 持久化 raw 不被 defaults 污染，老用户 enableTaskManager:true 仍能
 * 正确 migrate 到 enableAgentDeckMcp:true。
 *
 * 测试策略：直接 import + mock electron-store, 用 in-memory Map 模拟 raw store。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import log from 'electron-log/main';

// Step 3.3.2 console.log → logger.info migrate 后, 测试改 spy log.scope('settings-store').info
// (vitest-setup.ts mock 让 log.scope() 返 cached vi.fn() object 同 name 同一个 obj).
const settingsStoreLogger = log.scope('settings-store');

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
// F1 regression: 模拟 conf@10.2.0 line 131-138 真实行为：构造时如果传 defaults，
// 把 `{...defaults, ...fileStore}` 写回 mockRawStore（fileStore 缺哪个 default key 就被
// merged）。probe Store（不传 defaults）不触发写回。
vi.mock('electron-store', () => ({
  default: class MockStore {
    constructor(opts?: { name?: string; defaults?: Record<string, unknown> }) {
      if (opts?.defaults) {
        // conf 行为：先读 fs (mockRawStore snapshot)，merge defaults 后判 deepEqual，
        // 不等就写回 fs（mockRawStore）。简化判定：任一 default key 不在 fileStore → 触发写回。
        const fileStore = { ...mockRawStore };
        let needsWriteBack = false;
        for (const k of Object.keys(opts.defaults)) {
          if (!(k in fileStore)) {
            needsWriteBack = true;
            break;
          }
        }
        if (needsWriteBack) {
          // 模拟 _write fs：mockRawStore 物理更新成 merged 内容
          mockRawStore = { ...opts.defaults, ...fileStore };
        }
      }
      // 无 defaults 的 probe Store：构造时不修改 mockRawStore（与 conf line 115-119
      // `if (options.defaults)` 跳过分支对齐）
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
    (settingsStoreLogger.info as ReturnType<typeof vi.fn>).mockClear();
    mockRawStore = { enableTaskManager: true };

    const settings = await loadSettingsStore();
    settings.getAll(); // 触发 ensure()

    // smart migration set enableAgentDeckMcp=true
    expect(mockSet).toHaveBeenCalledWith('enableAgentDeckMcp', true);
    // warn 日志
    expect(settingsStoreLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('migrated enableTaskManager=true → enableAgentDeckMcp=true'),
    );
    // legacy key deleted
    expect(mockDelete).toHaveBeenCalledWith('enableTaskManager');
    
  });

  it('(2) legacy false + 无 explicit enableAgentDeckMcp → set enableAgentDeckMcp=false + legacy deleted', async () => {
    mockRawStore = { enableTaskManager: false };
    (settingsStoreLogger.info as ReturnType<typeof vi.fn>).mockClear();

    const settings = await loadSettingsStore();
    settings.getAll();

    // migration 保留 legacy explicit OFF
    expect(mockSet).toHaveBeenCalledWith('enableAgentDeckMcp', false);
    expect(settingsStoreLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('migrated enableTaskManager=false → enableAgentDeckMcp=false'),
    );
    // legacy key 仍被 REMOVED_KEYS delete
    expect(mockDelete).toHaveBeenCalledWith('enableTaskManager');
    
  });

  it('(3) raw 含 explicit enableAgentDeckMcp value → migration skip（用户决策优先）+ legacy deleted', async () => {
    mockRawStore = { enableTaskManager: true, enableAgentDeckMcp: false };
    (settingsStoreLogger.info as ReturnType<typeof vi.fn>).mockClear();

    const settings = await loadSettingsStore();
    settings.getAll();

    // migration 不覆盖用户 explicit false
    const enableSetCalls = mockSet.mock.calls.filter(
      (c) => c[0] === 'enableAgentDeckMcp',
    );
    expect(enableSetCalls).toHaveLength(0);
    // 不打 migration warn 日志
    expect(settingsStoreLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining('migrated enableTaskManager'),
    );
    // legacy key 仍 delete
    expect(mockDelete).toHaveBeenCalledWith('enableTaskManager');
    
  });

  it('(4) fresh install (raw 全空) → migration no-op + 不打 warn + 默认 ON (load-bearing：新用户路径不该看 warn 噪音)', async () => {
    mockRawStore = {};
    (settingsStoreLogger.info as ReturnType<typeof vi.fn>).mockClear();

    const settings = await loadSettingsStore();
    const all = settings.getAll();

    // 无 enableTaskManager 在 raw → migration 整段不进 if
    const enableSetCalls = mockSet.mock.calls.filter(
      (c) => c[0] === 'enableAgentDeckMcp',
    );
    expect(enableSetCalls).toHaveLength(0);
    expect(all.enableAgentDeckMcp).toBe(true);
    // 不打 migration warn 日志（load-bearing：新用户不该看噪音）
    expect(settingsStoreLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining('migrated enableTaskManager'),
    );
    // REMOVED_KEYS delete loop 也不调（key 不在 raw）
    const deleteCalls = mockDelete.mock.calls.filter(
      (c) => c[0] === 'enableTaskManager',
    );
    expect(deleteCalls).toHaveLength(0);
    
  });

  it('(5 F1 regression) conf defaults 写回 fs 后仍正确 migrate — 真实生产路径（deep-review R1 codex MED）', async () => {
    // 模拟生产真实路径：用户持久化 fs 只有 enableTaskManager:true，没有 enableAgentDeckMcp。
    // conf@10.2.0 构造 real Store 时把 defaults (含 enableAgentDeckMcp:false) merge 写回 fs。
    // F1 fix 前：settings-store.ts 后续读 store.store 拿到 merged 版本（含 enableAgentDeckMcp:false），
    //   `!('enableAgentDeckMcp' in raw)` 短路 → migration 不触发 → 老用户 enableTaskManager:true
    //   被 REMOVED_KEYS 删 → 能力丢失（fix 前会本 it fail）。
    // F1 fix 后：settings-store.ts 用独立 no-defaults probe Store snapshot fs raw 不受 defaults
    //   污染，judgment 仍命中 → migration 触发 set enableAgentDeckMcp:true（fix 后本 it pass）。
    mockRawStore = { enableTaskManager: true };
    (settingsStoreLogger.info as ReturnType<typeof vi.fn>).mockClear();

    const settings = await loadSettingsStore();
    settings.getAll();

    // 关键断言：即使 conf 真实行为已经污染 mockRawStore（real Store 构造时把
    // DEFAULT_SETTINGS 全部 merge 进 mockRawStore），migration 仍 set enableAgentDeckMcp:true
    expect(mockSet).toHaveBeenCalledWith('enableAgentDeckMcp', true);
    expect(settingsStoreLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('migrated enableTaskManager=true → enableAgentDeckMcp=true'),
    );
    expect(mockDelete).toHaveBeenCalledWith('enableTaskManager');

    // 反向验证：mockRawStore 在 real Store 构造后**确实被 defaults 污染**了
    // （proves mock 真实模拟 conf 行为，本 test 真考验 F1 fix）
    expect('enableAgentDeckMcp' in mockRawStore).toBe(true);
    
  });

  it('(6 F1 regression — windowTransparent 对称) conf defaults 写回 fs 后 transparentWhenPinned migration 仍触发（deep-review R2 双方独立提出 F-R2-A）', async () => {
    // F1 fix 影响面双键 — case (5) 覆盖 enableTaskManager；本 case (6) 对称覆盖
    // transparentWhenPinned → windowTransparent 同源 migration（settings-store.ts:74-80）。
    //
    // 模拟生产真实路径：老用户主动关过透明窗口（transparentWhenPinned:false），fs 上只有
    // transparentWhenPinned，没 windowTransparent。conf 构造 real Store 时把 DEFAULT_SETTINGS
    // 含的 windowTransparent:true merge 写回 fs。
    // F1 fix 前：raw 读 fs 拿到 merged 版本（含 windowTransparent:true default），
    //   `!('windowTransparent' in raw)` 短路 → migration 不触发 → 老用户透明偏好丢失。
    // F1 fix 后：probe Store 不受 defaults 污染，judgment 仍命中 → migration 触发 set
    //   windowTransparent:false（沿用 transparentWhenPinned 老值）。
    //
    // 用 false（与 default true 区分）让 `mockSet windowTransparent false` 断言可观察。
    mockRawStore = { transparentWhenPinned: false };
    (settingsStoreLogger.info as ReturnType<typeof vi.fn>).mockClear();

    const settings = await loadSettingsStore();
    settings.getAll();

    // 关键断言：migration 触发 + 沿用老 false 不被 default true 覆盖
    expect(mockSet).toHaveBeenCalledWith('windowTransparent', false);
    expect(settingsStoreLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('migrated transparentWhenPinned=false → windowTransparent'),
    );
    expect(mockDelete).toHaveBeenCalledWith('transparentWhenPinned');

    // 反向验证：mockRawStore 已被 defaults 污染（mock 真实模拟 conf 行为，本 test 真考验 F1 fix）
    expect('windowTransparent' in mockRawStore).toBe(true);
    
  });
});

// ────────────────────────────────────────────────────────────────────────────
// REVIEW_92（Batch G5）— value-uplift migration 一次性 sentinel + token canonical 格式
// ────────────────────────────────────────────────────────────────────────────

describe('REVIEW_92 — value-uplift migration 一次性 sentinel（reviewer-claude MED）', () => {
  it('(A) 老用户 fanOut=5 / rate=10 首次进来 → uplift 到 10/20 + 置 sentinel', async () => {
    mockRawStore = { mcpMaxFanOutPerParent: 5, mcpSpawnRatePerMinute: 10 };
    const settings = await loadSettingsStore();
    settings.getAll();
    expect(mockSet).toHaveBeenCalledWith('mcpMaxFanOutPerParent', 10);
    expect(mockSet).toHaveBeenCalledWith('mcpSpawnRatePerMinute', 20);
    // sentinel 置位
    expect(mockSet).toHaveBeenCalledWith('__valueUpliftMigrationDone', true);
  });

  it('(B) 关键 bug 修复：sentinel 已置 + 用户重选回 5/10 → migration 不 re-fire（选择存活）', async () => {
    // 模拟「上次启动已 uplift + 置 sentinel」后，用户在 UI 主动选回 5/10 持久化的状态
    mockRawStore = {
      mcpMaxFanOutPerParent: 5,
      mcpSpawnRatePerMinute: 10,
      __valueUpliftMigrationDone: true,
    };
    const settings = await loadSettingsStore();
    settings.getAll();
    // 关键：sentinel 存在 → 整块 migration 跳过 → 不把用户选的 5/10 压回 10/20
    const fanOutCalls = mockSet.mock.calls.filter((c) => c[0] === 'mcpMaxFanOutPerParent');
    const rateCalls = mockSet.mock.calls.filter((c) => c[0] === 'mcpSpawnRatePerMinute');
    expect(fanOutCalls).toHaveLength(0);
    expect(rateCalls).toHaveLength(0);
  });

  it('(C) 用户显式选 7/15（非老 default）→ 不 migrate + 置 sentinel', async () => {
    mockRawStore = { mcpMaxFanOutPerParent: 7, mcpSpawnRatePerMinute: 15 };
    const settings = await loadSettingsStore();
    settings.getAll();
    const fanOutCalls = mockSet.mock.calls.filter((c) => c[0] === 'mcpMaxFanOutPerParent');
    const rateCalls = mockSet.mock.calls.filter((c) => c[0] === 'mcpSpawnRatePerMinute');
    expect(fanOutCalls).toHaveLength(0);
    expect(rateCalls).toHaveLength(0);
    // 即便未触发任一迁移也置 sentinel（杜绝下次 re-fire）
    expect(mockSet).toHaveBeenCalledWith('__valueUpliftMigrationDone', true);
  });

  it('(D) fresh install (raw 空) → 不 migrate + 置 sentinel', async () => {
    mockRawStore = {};
    const settings = await loadSettingsStore();
    settings.getAll();
    const fanOutCalls = mockSet.mock.calls.filter((c) => c[0] === 'mcpMaxFanOutPerParent');
    expect(fanOutCalls).toHaveLength(0);
    expect(mockSet).toHaveBeenCalledWith('__valueUpliftMigrationDone', true);
  });

  it('(E) getAll() 剔除 __ 前缀内部 sentinel，不泄漏到 IPC/renderer', async () => {
    mockRawStore = { __valueUpliftMigrationDone: true };
    const settings = await loadSettingsStore();
    const all = settings.getAll() as unknown as Record<string, unknown>;
    expect('__valueUpliftMigrationDone' in all).toBe(false);
  });
});

describe('2026-06-04 — settings panel default uplift 一次性 sentinel', () => {
  it('(A) 老数值默认值首次进来 → uplift 到新默认 + 置 sentinel', async () => {
    mockRawStore = {
      activeWindowMs: 30 * 60 * 1000,
      permissionTimeoutMs: 5 * 60 * 1000,
      issueResolvedRetentionDays: 90,
    };

    const settings = await loadSettingsStore();
    settings.getAll();

    expect(mockSet).toHaveBeenCalledWith('activeWindowMs', 60 * 60 * 1000);
    expect(mockSet).toHaveBeenCalledWith('permissionTimeoutMs', 30 * 60 * 1000);
    expect(mockSet).toHaveBeenCalledWith('issueResolvedRetentionDays', 30);
    expect(mockSet.mock.calls.filter((c) => c[0] === 'enableAgentDeckMcp')).toHaveLength(0);
    expect(mockSet).toHaveBeenCalledWith('__settingsDefaults20260604Done', true);
  });

  it('(B) sentinel 已置 + 用户改回旧值 → migration 不 re-fire', async () => {
    mockRawStore = {
      activeWindowMs: 30 * 60 * 1000,
      permissionTimeoutMs: 5 * 60 * 1000,
      issueResolvedRetentionDays: 90,
      enableAgentDeckMcp: false,
      __settingsDefaults20260604Done: true,
    };

    const settings = await loadSettingsStore();
    settings.getAll();

    for (const key of [
      'activeWindowMs',
      'permissionTimeoutMs',
      'issueResolvedRetentionDays',
      'enableAgentDeckMcp',
    ]) {
      expect(mockSet.mock.calls.filter((c) => c[0] === key)).toHaveLength(0);
    }
  });

  it('(C) 用户自定义非旧默认值 → 不 migrate + 置 sentinel', async () => {
    mockRawStore = {
      activeWindowMs: 45 * 60 * 1000,
      permissionTimeoutMs: 10 * 60 * 1000,
      issueResolvedRetentionDays: 14,
      enableAgentDeckMcp: true,
    };

    const settings = await loadSettingsStore();
    settings.getAll();

    expect(mockSet.mock.calls.filter((c) => c[0] === 'activeWindowMs')).toHaveLength(0);
    expect(mockSet.mock.calls.filter((c) => c[0] === 'permissionTimeoutMs')).toHaveLength(0);
    expect(mockSet.mock.calls.filter((c) => c[0] === 'issueResolvedRetentionDays')).toHaveLength(0);
    expect(mockSet.mock.calls.filter((c) => c[0] === 'enableAgentDeckMcp')).toHaveLength(0);
    expect(mockSet).toHaveBeenCalledWith('__settingsDefaults20260604Done', true);
  });

  it('(D) legacy enableTaskManager=false 仍保留 MCP explicit OFF', async () => {
    mockRawStore = { enableTaskManager: false };

    const settings = await loadSettingsStore();
    settings.getAll();

    expect(mockSet).toHaveBeenCalledWith('enableAgentDeckMcp', false);
    expect(mockDelete).toHaveBeenCalledWith('enableTaskManager');
  });

  it('(E) 新版 enableAgentDeckMcp=false 无 legacy key → 保留用户显式关闭', async () => {
    mockRawStore = { enableAgentDeckMcp: false };

    const settings = await loadSettingsStore();
    settings.getAll();

    expect(mockSet.mock.calls.filter((c) => c[0] === 'enableAgentDeckMcp')).toHaveLength(0);
    expect(mockSet).toHaveBeenCalledWith('__settingsDefaults20260604Done', true);
  });
});

describe('2026-06-04 — Claude Code sandbox default uplift', () => {
  it('(A) 旧默认 off 首次进来 → uplift 到 workspace-write + 置独立 sentinel', async () => {
    mockRawStore = { claudeCodeSandbox: 'off', __settingsDefaults20260604Done: true };

    const settings = await loadSettingsStore();
    const all = settings.getAll();

    expect(mockSet).toHaveBeenCalledWith('claudeCodeSandbox', 'workspace-write');
    expect(mockSet).toHaveBeenCalledWith('__claudeSandboxDefault20260604Done', true);
    expect(all.claudeCodeSandbox).toBe('workspace-write');
  });

  it('(B) sentinel 已置 + 用户改回 off → migration 不 re-fire', async () => {
    mockRawStore = {
      claudeCodeSandbox: 'off',
      __claudeSandboxDefault20260604Done: true,
    };

    const settings = await loadSettingsStore();
    const all = settings.getAll();

    expect(mockSet.mock.calls.filter((c) => c[0] === 'claudeCodeSandbox')).toHaveLength(0);
    expect(all.claudeCodeSandbox).toBe('off');
  });

  it('(C) fresh install → 默认 workspace-write + 内部 sentinel 不泄漏', async () => {
    mockRawStore = {};

    const settings = await loadSettingsStore();
    const all = settings.getAll() as unknown as Record<string, unknown>;

    expect(all.claudeCodeSandbox).toBe('workspace-write');
    expect('__claudeSandboxDefault20260604Done' in all).toBe(false);
  });
});

describe('REVIEW_92 — token canonical 格式校验（reviewer-codex LOW）', () => {
  it('malformed 64-char token（64 个空格）→ 重生成 canonical hex', async () => {
    mockRawStore = {
      hookServerToken: ' '.repeat(64),
      mcpServerToken: 'x'.repeat(64),
    };
    const settings = await loadSettingsStore();
    settings.getAll();
    // 两个 malformed token 都被重生成
    const hookCalls = mockSet.mock.calls.filter((c) => c[0] === 'hookServerToken');
    const mcpCalls = mockSet.mock.calls.filter((c) => c[0] === 'mcpServerToken');
    expect(hookCalls.length).toBeGreaterThan(0);
    expect(mcpCalls.length).toBeGreaterThan(0);
    expect(hookCalls[0][1]).toMatch(/^[0-9a-f]{64}$/);
    expect(mcpCalls[0][1]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('canonical token（64 hex）→ 不重生成（稳定）', async () => {
    const validHook = 'a'.repeat(64); // 合法 lowercase hex
    const validMcp = '0123456789abcdef'.repeat(4); // 64 char lowercase hex
    mockRawStore = { hookServerToken: validHook, mcpServerToken: validMcp };
    const settings = await loadSettingsStore();
    settings.getAll();
    const hookCalls = mockSet.mock.calls.filter((c) => c[0] === 'hookServerToken');
    const mcpCalls = mockSet.mock.calls.filter((c) => c[0] === 'mcpServerToken');
    expect(hookCalls).toHaveLength(0);
    expect(mcpCalls).toHaveLength(0);
  });

  it('null token（fresh install）→ 生成 canonical hex', async () => {
    mockRawStore = {};
    const settings = await loadSettingsStore();
    settings.getAll();
    const hookCalls = mockSet.mock.calls.filter((c) => c[0] === 'hookServerToken');
    expect(hookCalls.length).toBeGreaterThan(0);
    expect(hookCalls[0][1]).toMatch(/^[0-9a-f]{64}$/);
  });
});
