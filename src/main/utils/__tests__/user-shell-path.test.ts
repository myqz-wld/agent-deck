/**
 * user-shell-path.ts 单测 (plan sdk-spawn-shell-path-20260529 §Step 3.3 + Step 3.6 fix
 *  + Step 3.6 deep-review Round 2 INFO nonce hardening follow-up)。
 *
 * 核心覆盖:
 * - **nonce-marked PATH parse**: 用 `__AD_PATH_<uuid-v4>__` per-startup nonce 包围 PATH
 *   输出(模块加载时一次生成,export 给 test 用真实 marker 构造 mock stdout),不依赖
 *   last-line — 防 zsh `.zlogout` 等结束 hook 输出污染 last-line(Step 3.6 reviewer-codex
 *   Round 1 MED-1 hardening,/tmp HOME + .zlogout 实测铁证)。
 *
 *   **nonce per-startup 替代 hardcoded sentinel**(Step 3.6 deep-review Round 2 INFO
 *   hardening follow-up):rc 文件无法预知主进程启动时随机生成的 UUID → 关闭 (a) user
 *   PATH 含 hardcoded `__AGENT_DECK_PATH_END__` substring 误匹配 + (b) rc echo 写假
 *   sentinel 对污染 first-match 两个 attack vector
 * - **execFileSync 三状态**: success (mocked nonce return) / throw / 无 nonce 在输出 — 每个
 *   返预期值 + console.warn 行为
 * - **sentinel 二分 memo (§不变量 6)**: success/failure/no-nonce 三路径都「连调 2 次只跑
 *   execFileSync 1 次 + console.warn 只 1 次」— 旧 design 用 `_cached: string | null` 单变量
 *   会 fail 失败路径 memo (因 `_cached === null` 同时表示「未初始化」与「失败」), test 必须
 *   钉住失败路径 memo (Round 1 reviewer-codex MED-2 fix)
 * - **NONCE_MARKER per-module-load 唯一**: 3 次 `vi.resetModules()` + dynamic import 拿 3
 *   个不同 UUID + marker shape 匹配 `__AD_PATH_<uuid-v4>__` regex
 * - **dedupePath 保序去重 (§不变量 4)**: 含重复 → Set 顺序保留 + 输入空 → 返空
 * - **unionUserShellPath 拼接 + 失败兜底 (§不变量 2/3/4)**: 拼接顺序 user 优先 / capture
 *   失败 → originalPath / originalPath undefined → user PATH / originalPath '' → user PATH
 *   (Step 3.6 reviewer-claude INFO-2)
 * - **$SHELL undefined → /bin/zsh fallback (impl L81)**: Step 3.6 reviewer-claude INFO-3
 * - **zsh .zlogout 污染防御 (Step 3.6 reviewer-codex MED-1)**: mock stdout 含 nonce PATH +
 *   后接 logout 文本 → parse 拿到 nonce 内 PATH 而非 logout 文本
 *
 * mock 策略: vi.mock('node:child_process') 顶层 mock execFileSync, 每个 test beforeEach
 * 用 vi.resetModules() + dynamic import 拿 fresh module 实例 (重置 module-level `captured`
 * / `cached` state + 重新生成 NONCE_MARKER) — 避免 test 间 memo state 互相污染。
 */
import { describe, expect, it, beforeEach, vi, type Mock } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

function wrap(marker: string, path: string): string {
  return `${marker}${path}${marker}\n`;
}

async function freshImport(): Promise<{
  captureUserShellPath: () => string | null;
  dedupePath: (path: string | undefined) => string;
  unionUserShellPath: (originalPath: string | undefined) => string;
  NONCE_MARKER: string;
  execFileSync: Mock;
}> {
  vi.resetModules();
  const { execFileSync } = await import('node:child_process');
  const mod = await import('../user-shell-path');
  return {
    captureUserShellPath: mod.captureUserShellPath,
    dedupePath: mod.dedupePath,
    unionUserShellPath: mod.unionUserShellPath,
    NONCE_MARKER: mod.NONCE_MARKER,
    execFileSync: execFileSync as unknown as Mock,
  };
}

describe('captureUserShellPath', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns captured PATH when nonce-marked line present', async () => {
    const { captureUserShellPath, execFileSync, NONCE_MARKER } = await freshImport();
    execFileSync.mockReturnValue(
      wrap(NONCE_MARKER, '/Users/foo/.nvm/bin:/opt/homebrew/bin:/usr/bin'),
    );
    expect(captureUserShellPath()).toBe('/Users/foo/.nvm/bin:/opt/homebrew/bin:/usr/bin');
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  // Step 3.6 reviewer-codex MED-1: zsh .zlogout 输出会污染 last-line parse
  // 修法用 nonce marker 包围 PATH → 不论 logout 文本写多少行都不影响 PATH 提取
  it('extracts nonce-marked PATH even when zsh .zlogout writes after (no last-line confusion)', async () => {
    const { captureUserShellPath, execFileSync, NONCE_MARKER } = await freshImport();
    execFileSync.mockReturnValue(
      wrap(NONCE_MARKER, '/opt/homebrew/bin:/usr/bin') + 'LOGOUT_MARKER\ngoodbye!\n',
    );
    expect(captureUserShellPath()).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('extracts nonce-marked PATH even when rc echo writes BEFORE the marker', async () => {
    const { captureUserShellPath, execFileSync, NONCE_MARKER } = await freshImport();
    execFileSync.mockReturnValue(
      'rc-script: loading nvm\nstarship init complete\n' +
        wrap(NONCE_MARKER, '/opt/homebrew/bin:/usr/bin'),
    );
    expect(captureUserShellPath()).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('returns null + console.warn when execFileSync throws (unsupported -ilc / shell missing)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { captureUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockImplementation(() => {
      throw new Error('Unknown option: -lc');
    });
    expect(captureUserShellPath()).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('[user-shell-path] failed to capture');
  });

  // 取代旧「empty output」测试 — 现在依赖 nonce 不依赖空白
  it('returns null + console.warn when stdout lacks nonce marker', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { captureUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockReturnValue('only noise without any nonce\nanother line\n');
    expect(captureUserShellPath()).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('[user-shell-path] no nonce-marked PATH line');
  });

  it('returns null + console.warn when stdout completely empty (no nonce)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { captureUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockReturnValue('');
    expect(captureUserShellPath()).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('memoizes success result (2 calls only execFileSync 1 time)', async () => {
    const { captureUserShellPath, execFileSync, NONCE_MARKER } = await freshImport();
    execFileSync.mockReturnValue(wrap(NONCE_MARKER, '/usr/bin'));
    expect(captureUserShellPath()).toBe('/usr/bin');
    expect(captureUserShellPath()).toBe('/usr/bin');
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  // §不变量 6 sentinel 二分 — 失败路径也命中 memo
  // 旧 design (`_cached: string | null` 单变量, null 同时表示「未初始化」+「失败」) fail 此 test
  it('memoizes failure result (2 calls only execFileSync 1 time + console.warn 1 time)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { captureUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockImplementation(() => {
      throw new Error('Unknown option: -lc');
    });
    expect(captureUserShellPath()).toBeNull();
    expect(captureUserShellPath()).toBeNull();
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  // §不变量 6 sentinel 二分 — no-nonce 路径也命中 memo
  it('memoizes no-nonce result (2 calls only execFileSync 1 time + console.warn 1 time)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { captureUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockReturnValue('no nonce here\njust noise\n');
    expect(captureUserShellPath()).toBeNull();
    expect(captureUserShellPath()).toBeNull();
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  // Step 3.6 reviewer-claude INFO-3: $SHELL undefined → /bin/zsh fallback 显式 test
  it('falls back to /bin/zsh when $SHELL is not set', async () => {
    const originalShell = process.env.SHELL;
    delete process.env.SHELL;
    try {
      const { captureUserShellPath, execFileSync, NONCE_MARKER } = await freshImport();
      execFileSync.mockReturnValue(wrap(NONCE_MARKER, '/usr/bin'));
      captureUserShellPath();
      expect(execFileSync.mock.calls[0][0]).toBe('/bin/zsh');
    } finally {
      if (originalShell !== undefined) process.env.SHELL = originalShell;
    }
  });
});

// Step 3.6 deep-review Round 2 INFO hardening follow-up: nonce per-startup 唯一
describe('NONCE_MARKER per-startup uniqueness', () => {
  it('generates fresh nonce per module load (3 vi.resetModules() → 3 different markers)', async () => {
    const { NONCE_MARKER: marker1 } = await freshImport();
    const { NONCE_MARKER: marker2 } = await freshImport();
    const { NONCE_MARKER: marker3 } = await freshImport();
    // 3 fresh imports → 3 different UUIDs (v4 collision probability ≈ 0)
    expect(new Set([marker1, marker2, marker3]).size).toBe(3);
  });

  it('marker shape matches __AD_PATH_<uuid-v4>__ regex', async () => {
    const { NONCE_MARKER } = await freshImport();
    // UUID v4: 8-4-4-4-12 hex/hyphen, total 36 chars between __AD_PATH_ and __
    expect(NONCE_MARKER).toMatch(
      /^__AD_PATH_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}__$/,
    );
  });
});

describe('dedupePath', () => {
  it('returns empty string for undefined / empty input', async () => {
    const { dedupePath } = await freshImport();
    expect(dedupePath(undefined)).toBe('');
    expect(dedupePath('')).toBe('');
  });

  it('preserves order while deduplicating (§不变量 4)', async () => {
    const { dedupePath } = await freshImport();
    expect(dedupePath('/a:/b:/a:/c:/b')).toBe('/a:/b:/c');
    expect(dedupePath('/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin')).toBe(
      '/opt/homebrew/bin:/usr/bin',
    );
  });

  it('handles single-element PATH unchanged', async () => {
    const { dedupePath } = await freshImport();
    expect(dedupePath('/usr/bin')).toBe('/usr/bin');
  });
});

describe('unionUserShellPath', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('union user PATH first, original PATH last, dedupe (§不变量 3+4)', async () => {
    const { unionUserShellPath, execFileSync, NONCE_MARKER } = await freshImport();
    execFileSync.mockReturnValue(
      wrap(NONCE_MARKER, '/Users/foo/.nvm/bin:/opt/homebrew/bin:/usr/bin'),
    );
    expect(unionUserShellPath('/usr/bin:/bin:/agent-deck-plugin/bin')).toBe(
      // user PATH (3) + original PATH (3) dedupe /usr/bin (重复) → 5
      '/Users/foo/.nvm/bin:/opt/homebrew/bin:/usr/bin:/bin:/agent-deck-plugin/bin',
    );
  });

  it('falls back to originalPath when captureUserShellPath fails (§不变量 2)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { unionUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockImplementation(() => {
      throw new Error('Unknown option: -lc');
    });
    expect(unionUserShellPath('/usr/bin:/bin')).toBe('/usr/bin:/bin');
  });

  it('returns user PATH when originalPath is undefined', async () => {
    const { unionUserShellPath, execFileSync, NONCE_MARKER } = await freshImport();
    execFileSync.mockReturnValue(wrap(NONCE_MARKER, '/opt/homebrew/bin:/usr/bin'));
    expect(unionUserShellPath(undefined)).toBe('/opt/homebrew/bin:/usr/bin');
  });

  // Step 3.6 reviewer-claude INFO-2: originalPath = '' (空字符串非 undefined) 显式 test
  // 当前 impl `if (!originalPath) return userPath;` falsy check 让 '' 与 undefined 走同款分支
  it('returns user PATH when originalPath is empty string (falsy parity with undefined)', async () => {
    const { unionUserShellPath, execFileSync, NONCE_MARKER } = await freshImport();
    execFileSync.mockReturnValue(wrap(NONCE_MARKER, '/opt/homebrew/bin:/usr/bin'));
    expect(unionUserShellPath('')).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('returns empty string when both fail (capture fails + originalPath undefined)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { unionUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockImplementation(() => {
      throw new Error('Unknown option: -lc');
    });
    expect(unionUserShellPath(undefined)).toBe('');
  });
});
