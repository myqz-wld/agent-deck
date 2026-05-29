/**
 * user-shell-path.ts 单测 (plan sdk-spawn-shell-path-20260529 §Step 3.3,11 条 test)。
 *
 * 核心覆盖:
 * - **execFileSync 三状态**: success (mocked return) / throw / 空白输出 — 每个返预期值 +
 *   console.warn 行为
 * - **sentinel 二分 memo (§不变量 6)**: success/failure/empty 三路径都「连调 2 次只跑
 *   execFileSync 1 次 + console.warn 只 1 次」— 旧 design 用 `_cached: string | null` 单变量
 *   会 fail 失败路径 memo (因 `_cached === null` 同时表示「未初始化」与「失败」), test 必须
 *   钉住失败路径 memo (reviewer-codex Round 1 MED-2 fix)
 * - **dedupePath 保序去重 (§不变量 4)**: 含重复 → Set 顺序保留 + 输入空 → 返空
 * - **unionUserShellPath 拼接 + 失败兜底 (§不变量 2/3/4)**: 拼接顺序 user 优先 / capture
 *   失败 → originalPath / originalPath undefined → user PATH
 *
 * mock 策略: vi.mock('node:child_process') 顶层 mock execFileSync, 每个 test beforeEach
 * 用 vi.resetModules() + dynamic import 拿 fresh module 实例 (重置 module-level `captured`
 * / `cached` state) — 避免 test 间 memo state 互相污染。
 */
import { describe, expect, it, beforeEach, vi, type Mock } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

async function freshImport(): Promise<{
  captureUserShellPath: () => string | null;
  dedupePath: (path: string | undefined) => string;
  unionUserShellPath: (originalPath: string | undefined) => string;
  execFileSync: Mock;
}> {
  vi.resetModules();
  const { execFileSync } = await import('node:child_process');
  const mod = await import('../user-shell-path');
  return {
    captureUserShellPath: mod.captureUserShellPath,
    dedupePath: mod.dedupePath,
    unionUserShellPath: mod.unionUserShellPath,
    execFileSync: execFileSync as unknown as Mock,
  };
}

describe('captureUserShellPath', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns captured PATH on success (single-line stdout)', async () => {
    const { captureUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockReturnValue('/Users/foo/.nvm/bin:/opt/homebrew/bin:/usr/bin');
    expect(captureUserShellPath()).toBe('/Users/foo/.nvm/bin:/opt/homebrew/bin:/usr/bin');
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('returns last non-empty line when stdout has rc echo noise', async () => {
    const { captureUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockReturnValue(
      'rc-script: loading nvm\n\n/Users/foo/.nvm/bin:/opt/homebrew/bin:/usr/bin',
    );
    expect(captureUserShellPath()).toBe('/Users/foo/.nvm/bin:/opt/homebrew/bin:/usr/bin');
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

  it('returns null + console.warn when execFileSync returns empty/whitespace output', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { captureUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockReturnValue('\n  \n  \n');
    expect(captureUserShellPath()).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('[user-shell-path] empty output');
  });

  it('memoizes success result (2 calls only execFileSync 1 time)', async () => {
    const { captureUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockReturnValue('/usr/bin');
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

  // §不变量 6 sentinel 二分 — empty 路径也命中 memo
  it('memoizes empty-output result (2 calls only execFileSync 1 time + console.warn 1 time)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { captureUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockReturnValue('\n  \n');
    expect(captureUserShellPath()).toBeNull();
    expect(captureUserShellPath()).toBeNull();
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
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
    const { unionUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockReturnValue('/Users/foo/.nvm/bin:/opt/homebrew/bin:/usr/bin');
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
    const { unionUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockReturnValue('/opt/homebrew/bin:/usr/bin');
    expect(unionUserShellPath(undefined)).toBe('/opt/homebrew/bin:/usr/bin');
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
