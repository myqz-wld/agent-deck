/**
 * Priority chain unit test for `resolveClaudeBinary()`(plan
 * add-claude-cli-path-override-and-bump-sdks-20260520 Follow-up F3 实施)。
 *
 * 测试覆盖优先级链 6 边界 case(spike3 §B1 + F2 加 existsSync 行为):
 * 1. claudeCliPath = null → falsy → fallback bundled(无 console.warn)
 * 2. claudeCliPath = "" → falsy → fallback bundled(无 console.warn)
 * 3. claudeCliPath = "   \t  " → trim 后空 → falsy → fallback bundled(无 console.warn)
 * 4. claudeCliPath = "/path/to/missing" + existsSync false → fallback bundled + console.warn
 * 5. claudeCliPath = "/usr/bin/claude" + existsSync true → user override
 * 6. claudeCliPath = "  /usr/bin/claude  " + existsSync true(对 trim 后路径)→ trim 后的 path 用作 override
 *
 * Mock 策略:
 * - settingsStore.get('claudeCliPath') 受测变量(每 case set 不同值)
 * - existsSync mock 对 user override 路径返 true/false
 * - getPathToClaudeCodeExecutable 返固定 '/bundled/claude'
 * - console.warn spy 验证 warn 是否触发
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/store/settings-store', () => ({
  settingsStore: {
    get: vi.fn(),
    set: vi.fn(),
    getAll: vi.fn(() => ({})),
    patch: vi.fn(),
  },
}));

vi.mock('@main/adapters/claude-code/sdk-runtime', () => ({
  getPathToClaudeCodeExecutable: vi.fn(() => '/bundled/claude'),
  getSdkRuntimeOptions: () => ({ executable: 'node', env: {} }),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

describe('resolveClaudeBinary — priority chain (plan F3)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('case 1: claudeCliPath=null → fallback bundled, no warn', async () => {
    const { settingsStore } = await import('@main/store/settings-store');
    (settingsStore.get as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const { resolveClaudeBinary } = await import('@main/adapters/claude-code/resolve-claude-binary');
    expect(resolveClaudeBinary()).toBe('/bundled/claude');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('case 2: claudeCliPath="" → fallback bundled, no warn', async () => {
    const { settingsStore } = await import('@main/store/settings-store');
    (settingsStore.get as ReturnType<typeof vi.fn>).mockReturnValue('');
    const { resolveClaudeBinary } = await import('@main/adapters/claude-code/resolve-claude-binary');
    expect(resolveClaudeBinary()).toBe('/bundled/claude');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('case 3: claudeCliPath="   \\t  " (全空白) → trim falsy → fallback bundled, no warn', async () => {
    const { settingsStore } = await import('@main/store/settings-store');
    (settingsStore.get as ReturnType<typeof vi.fn>).mockReturnValue('   \t  ');
    const { resolveClaudeBinary } = await import('@main/adapters/claude-code/resolve-claude-binary');
    expect(resolveClaudeBinary()).toBe('/bundled/claude');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('case 4: user override path 不存在 → fallback bundled + console.warn', async () => {
    const { settingsStore } = await import('@main/store/settings-store');
    (settingsStore.get as ReturnType<typeof vi.fn>).mockReturnValue('/path/to/missing');
    const fs = await import('node:fs');
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const { resolveClaudeBinary } = await import('@main/adapters/claude-code/resolve-claude-binary');
    expect(resolveClaudeBinary()).toBe('/bundled/claude');
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('/path/to/missing'),
    );
  });

  it('case 5: user override path 存在 → 用 user 路径, no warn', async () => {
    const { settingsStore } = await import('@main/store/settings-store');
    (settingsStore.get as ReturnType<typeof vi.fn>).mockReturnValue('/usr/bin/claude');
    const fs = await import('node:fs');
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const { resolveClaudeBinary } = await import('@main/adapters/claude-code/resolve-claude-binary');
    expect(resolveClaudeBinary()).toBe('/usr/bin/claude');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('case 6: user override 含前后空白 + trim 后路径存在 → trim 后路径用作 override (filepicker 残留 user-friendly)', async () => {
    const { settingsStore } = await import('@main/store/settings-store');
    (settingsStore.get as ReturnType<typeof vi.fn>).mockReturnValue('  /usr/bin/claude  ');
    const fs = await import('node:fs');
    // existsSync called with trim 后路径 '/usr/bin/claude' → true
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: unknown) => {
      return p === '/usr/bin/claude';
    });
    const { resolveClaudeBinary } = await import('@main/adapters/claude-code/resolve-claude-binary');
    expect(resolveClaudeBinary()).toBe('/usr/bin/claude');
    expect(warnSpy).not.toHaveBeenCalled();
    // verify existsSync called with TRIMMED path not raw
    expect(fs.existsSync).toHaveBeenCalledWith('/usr/bin/claude');
  });
});
