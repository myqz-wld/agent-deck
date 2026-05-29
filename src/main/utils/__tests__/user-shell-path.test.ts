/**
 * user-shell-path.ts 单测 (plan sdk-spawn-shell-path-20260529 §Step 3.3 + Step 3.6 fix)。
 *
 * 核心覆盖:
 * - **sentinel-marked PATH parse**: 用 `__AGENT_DECK_PATH_BEGIN__<PATH>__AGENT_DECK_PATH_END__`
 *   sentinel 包围 PATH 输出,不依赖 last-line — 防 zsh `.zlogout` 等结束 hook 输出污染 last-line
 *   (Step 3.6 reviewer-codex Round 1 MED-1 hardening,/tmp HOME + .zlogout 实测铁证)
 * - **execFileSync 三状态**: success (mocked sentinel return) / throw / 无 sentinel 在输出 — 每个返
 *   预期值 + console.warn 行为
 * - **sentinel 二分 memo (§不变量 6)**: success/failure/no-sentinel 三路径都「连调 2 次只跑
 *   execFileSync 1 次 + console.warn 只 1 次」— 旧 design 用 `_cached: string | null` 单变量
 *   会 fail 失败路径 memo (因 `_cached === null` 同时表示「未初始化」与「失败」), test 必须
 *   钉住失败路径 memo (Round 1 reviewer-codex MED-2 fix)
 * - **dedupePath 保序去重 (§不变量 4)**: 含重复 → Set 顺序保留 + 输入空 → 返空
 * - **unionUserShellPath 拼接 + 失败兜底 (§不变量 2/3/4)**: 拼接顺序 user 优先 / capture
 *   失败 → originalPath / originalPath undefined → user PATH / originalPath '' → user PATH
 *   (Step 3.6 reviewer-claude INFO-2)
 * - **$SHELL undefined → /bin/zsh fallback (impl L50)**: Step 3.6 reviewer-claude INFO-3
 * - **zsh .zlogout 污染防御 (Step 3.6 reviewer-codex MED-1)**: mock stdout 含 sentinel PATH +
 *   后接 logout 文本 → parse 拿到 sentinel 内 PATH 而非 logout 文本
 *
 * mock 策略: vi.mock('node:child_process') 顶层 mock execFileSync, 每个 test beforeEach
 * 用 vi.resetModules() + dynamic import 拿 fresh module 实例 (重置 module-level `captured`
 * / `cached` state) — 避免 test 间 memo state 互相污染。
 */
import { describe, expect, it, beforeEach, vi, type Mock } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const SENTINEL_BEGIN = '__AGENT_DECK_PATH_BEGIN__';
const SENTINEL_END = '__AGENT_DECK_PATH_END__';

function wrap(path: string): string {
  return `${SENTINEL_BEGIN}${path}${SENTINEL_END}\n`;
}

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

  it('returns captured PATH when sentinel-marked line present', async () => {
    const { captureUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockReturnValue(wrap('/Users/foo/.nvm/bin:/opt/homebrew/bin:/usr/bin'));
    expect(captureUserShellPath()).toBe('/Users/foo/.nvm/bin:/opt/homebrew/bin:/usr/bin');
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  // Step 3.6 reviewer-codex MED-1: zsh .zlogout 输出会污染 last-line parse
  // 修法用 sentinel marker 包围 PATH → 不论 logout 文本写多少行都不影响 PATH 提取
  it('extracts sentinel-marked PATH even when zsh .zlogout writes after (no last-line confusion)', async () => {
    const { captureUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockReturnValue(
      wrap('/opt/homebrew/bin:/usr/bin') + 'LOGOUT_MARKER\ngoodbye!\n',
    );
    expect(captureUserShellPath()).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('extracts sentinel-marked PATH even when rc echo writes BEFORE the marker', async () => {
    const { captureUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockReturnValue(
      'rc-script: loading nvm\nstarship init complete\n' + wrap('/opt/homebrew/bin:/usr/bin'),
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

  // 取代旧「empty output」测试 — 现在依赖 sentinel 不依赖空白
  it('returns null + console.warn when stdout lacks sentinel marker', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { captureUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockReturnValue('only noise without any sentinel\nanother line\n');
    expect(captureUserShellPath()).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('[user-shell-path] no sentinel-marked PATH line');
  });

  it('returns null + console.warn when stdout completely empty (no sentinel)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { captureUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockReturnValue('');
    expect(captureUserShellPath()).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('memoizes success result (2 calls only execFileSync 1 time)', async () => {
    const { captureUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockReturnValue(wrap('/usr/bin'));
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

  // §不变量 6 sentinel 二分 — no-sentinel 路径也命中 memo
  it('memoizes no-sentinel result (2 calls only execFileSync 1 time + console.warn 1 time)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { captureUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockReturnValue('no sentinel here\njust noise\n');
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
      const { captureUserShellPath, execFileSync } = await freshImport();
      execFileSync.mockReturnValue(wrap('/usr/bin'));
      captureUserShellPath();
      expect(execFileSync.mock.calls[0][0]).toBe('/bin/zsh');
    } finally {
      if (originalShell !== undefined) process.env.SHELL = originalShell;
    }
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
    execFileSync.mockReturnValue(wrap('/Users/foo/.nvm/bin:/opt/homebrew/bin:/usr/bin'));
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
    execFileSync.mockReturnValue(wrap('/opt/homebrew/bin:/usr/bin'));
    expect(unionUserShellPath(undefined)).toBe('/opt/homebrew/bin:/usr/bin');
  });

  // Step 3.6 reviewer-claude INFO-2: originalPath = '' (空字符串非 undefined) 显式 test
  // 当前 impl `if (!originalPath) return userPath;` falsy check 让 '' 与 undefined 走同款分支
  it('returns user PATH when originalPath is empty string (falsy parity with undefined)', async () => {
    const { unionUserShellPath, execFileSync } = await freshImport();
    execFileSync.mockReturnValue(wrap('/opt/homebrew/bin:/usr/bin'));
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
