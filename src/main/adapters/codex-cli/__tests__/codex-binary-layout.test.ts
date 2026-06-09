/**
 * codex-binary.ts vendor 双布局回归测试（Codex runtime 0.131 → 0.135 升级踩坑）。
 *
 * **背景**：Codex runtime ≥ 0.135 把 vendored 二进制从 `vendor/<triple>/codex/codex` 挪到
 * `vendor/<triple>/bin/codex`。`resolveBundledCodexBinary()` 原本硬编码旧 `codex/codex` 布局，
 * 升级后打包 .app 找不到二进制（typecheck 抓不到 path 字符串漂移）→ codex 整条链失效。
 *
 * 本测试用 fixture 目录树覆盖：
 * - new 布局（0.135+ `bin/codex`）→ 命中 new
 * - legacy 布局（≤0.134 `codex/codex`）→ fallback 命中 legacy
 * - 两布局都缺 → null（不瞎指路径让 SDK 走自身 resolve）
 * - dev 模式（!isPackaged）→ null
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_ROOT = join(tmpdir(), `codex-binary-layout-${process.pid}-${Date.now()}`);

// 可变 isPackaged，让单文件内切 dev / packaged 两态
const electronState = { isPackaged: true, resourcesPath: FIXTURE_ROOT };

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electronState.isPackaged;
    },
    getPath: (_name: string) => tmpdir(),
    getName: () => 'Agent Deck',
    setName: () => undefined,
  },
}));

// process.resourcesPath 不是标准 Node 字段（Electron 注入），测试里手动赋值
// （resolveBundledCodexBinary 读 process.resourcesPath）。
// ⚠️ Electron-as-node 下 process.resourcesPath 是 read-only（writable:false, configurable:true），
// 直接赋值抛 `TypeError: Cannot assign to read only property`（plan sqlite-tests-no-skip-20260601 D7）。
// 必须走 Object.defineProperty（configurable:true 让两 runtime 都能重定义 + 还原；
// 系统 node 下该属性本就 undefined 也能 defineProperty）。
const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

function setResourcesPath(value: string | undefined): void {
  Object.defineProperty(process, 'resourcesPath', {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

/** 仅 darwin-arm64 测试机上跑布局断言（其他平台 spec 不同，dev / null 分支仍覆盖） */
const isDarwinArm64 = process.platform === 'darwin' && process.arch === 'arm64';
const TRIPLE = 'aarch64-apple-darwin';
const PKG_DIR = 'codex-darwin-arm64';

function vendorTripleDir(): string {
  return join(
    FIXTURE_ROOT,
    'app.asar.unpacked',
    'node_modules',
    '@openai',
    PKG_DIR,
    'vendor',
    TRIPLE,
  );
}

beforeAll(() => {
  setResourcesPath(FIXTURE_ROOT);
});

afterAll(() => {
  if (existsSync(FIXTURE_ROOT)) rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  setResourcesPath(originalResourcesPath);
  electronState.isPackaged = true;
});

describe('resolveBundledCodexBinary vendor 双布局', () => {
  it('dev 模式（!isPackaged）→ null（让 SDK 走自身 resolve）', async () => {
    electronState.isPackaged = false;
    const { resolveBundledCodexBinary } = await import('../sdk-bridge/codex-binary');
    expect(resolveBundledCodexBinary()).toBeNull();
    electronState.isPackaged = true;
  });

  it('两布局都缺 → null（不瞎指路径）', async () => {
    // 清掉任何残留 fixture（保证干净）
    if (existsSync(vendorTripleDir())) rmSync(vendorTripleDir(), { recursive: true, force: true });
    const { resolveBundledCodexBinary } = await import('../sdk-bridge/codex-binary');
    if (isDarwinArm64) {
      expect(resolveBundledCodexBinary()).toBeNull();
    } else {
      // 非 darwin-arm64：spec 命中其他平台但 fixture 没建 → 仍 null
      expect(resolveBundledCodexBinary()).toBeNull();
    }
  });

  it.runIf(isDarwinArm64)('new 布局 bin/codex（0.135+）→ 命中 new', async () => {
    const dir = vendorTripleDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'codex'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'codex-package.json'), '{}\n'); // new 布局双条件（SDK 同款）
    const { resolveBundledCodexBinary } = await import('../sdk-bridge/codex-binary');
    expect(resolveBundledCodexBinary()).toBe(join(dir, 'bin', 'codex'));
  });

  it.runIf(isDarwinArm64)('仅 legacy 布局 codex/codex（≤0.134）→ fallback 命中 legacy', async () => {
    const dir = vendorTripleDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'codex'), { recursive: true });
    writeFileSync(join(dir, 'codex', 'codex'), '#!/bin/sh\n');
    const { resolveBundledCodexBinary } = await import('../sdk-bridge/codex-binary');
    expect(resolveBundledCodexBinary()).toBe(join(dir, 'codex', 'codex'));
  });

  it.runIf(isDarwinArm64)('new + legacy 同时存在 → 优先 new（与 SDK resolveNativePackage 同序）', async () => {
    const dir = vendorTripleDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    mkdirSync(join(dir, 'codex'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'codex'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'codex-package.json'), '{}\n');
    writeFileSync(join(dir, 'codex', 'codex'), '#!/bin/sh\n');
    const { resolveBundledCodexBinary } = await import('../sdk-bridge/codex-binary');
    expect(resolveBundledCodexBinary()).toBe(join(dir, 'bin', 'codex'));
  });

  // batch-B reviewer-claude LOW：new 布局双条件（bin/<binName> + codex-package.json）。畸形布局
  // 「有 bin/codex 但无 codex-package.json」→ 与 SDK 同款 fallback legacy（不认 new）。
  it.runIf(isDarwinArm64)('有 bin/codex 但无 codex-package.json → 认 legacy（与 SDK 双条件对齐）', async () => {
    const dir = vendorTripleDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'codex'), '#!/bin/sh\n'); // 不建 codex-package.json
    mkdirSync(join(dir, 'codex'), { recursive: true });
    writeFileSync(join(dir, 'codex', 'codex'), '#!/bin/sh\n');
    const { resolveBundledCodexBinary } = await import('../sdk-bridge/codex-binary');
    // bin/codex 存在但缺 codex-package.json → 不认 new → fallback legacy codex/codex
    expect(resolveBundledCodexBinary()).toBe(join(dir, 'codex', 'codex'));
  });
});

describe('resolveBundledCodexPathDirs / prependBundledCodexPathDirs（bundled rg helper PATH）', () => {
  it('dev 模式 → pathDirs []，prepend no-op', async () => {
    electronState.isPackaged = false;
    const { resolveBundledCodexPathDirs, prependBundledCodexPathDirs } = await import(
      '../sdk-bridge/codex-binary'
    );
    expect(resolveBundledCodexPathDirs()).toEqual([]);
    const env = { PATH: '/usr/bin' };
    prependBundledCodexPathDirs(env);
    expect(env.PATH).toBe('/usr/bin'); // 未改
    electronState.isPackaged = true;
  });

  it.runIf(isDarwinArm64)('new 布局 → codex-path/ 作 pathDir + prepend 进 PATH', async () => {
    const dir = vendorTripleDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    mkdirSync(join(dir, 'codex-path'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'codex'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'codex-package.json'), '{}\n'); // new 布局双条件
    writeFileSync(join(dir, 'codex-path', 'rg'), '#!/bin/sh\n');
    const { resolveBundledCodexPathDirs, prependBundledCodexPathDirs } = await import(
      '../sdk-bridge/codex-binary'
    );
    const helperDir = join(dir, 'codex-path');
    expect(resolveBundledCodexPathDirs()).toEqual([helperDir]);
    const env = { PATH: '/usr/bin:/bin' };
    prependBundledCodexPathDirs(env);
    expect(env.PATH).toBe(`${helperDir}:/usr/bin:/bin`);
  });

  it.runIf(isDarwinArm64)('legacy 布局 → path/ 作 pathDir', async () => {
    const dir = vendorTripleDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'codex'), { recursive: true });
    mkdirSync(join(dir, 'path'), { recursive: true });
    writeFileSync(join(dir, 'codex', 'codex'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'path', 'rg'), '#!/bin/sh\n');
    const { resolveBundledCodexPathDirs } = await import('../sdk-bridge/codex-binary');
    expect(resolveBundledCodexPathDirs()).toEqual([join(dir, 'path')]);
  });

  it.runIf(isDarwinArm64)('prepend 去重已存在条目（不重复 prepend）', async () => {
    const dir = vendorTripleDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    mkdirSync(join(dir, 'codex-path'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'codex'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'codex-package.json'), '{}\n');
    writeFileSync(join(dir, 'codex-path', 'rg'), '#!/bin/sh\n');
    const { prependBundledCodexPathDirs } = await import('../sdk-bridge/codex-binary');
    const helperDir = join(dir, 'codex-path');
    const env = { PATH: `${helperDir}:/usr/bin` }; // 已含 helperDir
    prependBundledCodexPathDirs(env);
    expect(env.PATH).toBe(`${helperDir}:/usr/bin`); // 去重不重复
  });

  it.runIf(isDarwinArm64)('bin 在但 codex-path 缺 → pathDirs []（existingDirs 语义）', async () => {
    const dir = vendorTripleDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'codex'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'codex-package.json'), '{}\n'); // new 布局，但不建 codex-path/
    const { resolveBundledCodexPathDirs } = await import('../sdk-bridge/codex-binary');
    expect(resolveBundledCodexPathDirs()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// win32 binName='codex.exe' 回归（deep-review batch-B finding）：resolveBundledCodexPathDirs 旧实现
// 硬编码 'codex' 探测 new 布局 bin/，但 win32 binName 是 codex.exe → new 布局误判成 legacy →
// bundled rg helper 不注入。修法：用 spec.binName 探测（与 resolveBundledCodexBinary 同款）。
// 测试机非 win32，故 stub process.platform/arch 让 PLATFORM_BINARY_MAP 命中 win32-x64。
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveBundledCodexPathDirs win32 binName=codex.exe 回归', () => {
  const WIN_TRIPLE = 'x86_64-pc-windows-msvc';
  const WIN_PKG_DIR = 'codex-win32-x64';
  const origPlatform = process.platform;
  const origArch = process.arch;

  function winVendorTripleDir(): string {
    return join(
      FIXTURE_ROOT,
      'app.asar.unpacked',
      'node_modules',
      '@openai',
      WIN_PKG_DIR,
      'vendor',
      WIN_TRIPLE,
    );
  }

  beforeAll(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
    electronState.isPackaged = true;
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    Object.defineProperty(process, 'arch', { value: origArch, configurable: true });
  });

  it('new 布局 bin/codex.exe + codex-path/ → 命中 codex-path（不被误判 legacy）', async () => {
    const dir = winVendorTripleDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    mkdirSync(join(dir, 'codex-path'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'codex.exe'), 'MZ\n'); // win32 binName 带 .exe
    writeFileSync(join(dir, 'codex-package.json'), '{}\n'); // new 布局双条件
    writeFileSync(join(dir, 'codex-path', 'rg.exe'), 'MZ\n');
    const { resolveBundledCodexBinary, resolveBundledCodexPathDirs } = await import(
      '../sdk-bridge/codex-binary'
    );
    // 二进制：spec.binName=codex.exe → 命中 new 布局
    expect(resolveBundledCodexBinary()).toBe(join(dir, 'bin', 'codex.exe'));
    // helper PATH：必须命中 codex-path/（旧硬编码 'codex' 会因 bin/codex 不存在误判 legacy → []）
    expect(resolveBundledCodexPathDirs()).toEqual([join(dir, 'codex-path')]);
  });

  it('legacy 布局 codex/codex.exe + path/ → 命中 path/', async () => {
    const dir = winVendorTripleDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'codex'), { recursive: true });
    mkdirSync(join(dir, 'path'), { recursive: true });
    writeFileSync(join(dir, 'codex', 'codex.exe'), 'MZ\n');
    writeFileSync(join(dir, 'path', 'rg.exe'), 'MZ\n');
    const { resolveBundledCodexPathDirs } = await import('../sdk-bridge/codex-binary');
    expect(resolveBundledCodexPathDirs()).toEqual([join(dir, 'path')]);
  });

  // batch-B reviewer-codex MED：win32 env key 是 `Path` 非 `PATH`，prepend 必须选对 key + 删重复变体，
  // 否则产生 {Path:原值, PATH:helper} 双 key 分叉 → codex 子进程读 Path(无 helper) → bundled rg 不生效。
  it('prepend win32：env={Path} → helper prepend 到 Path（不产生双 key 分叉）', async () => {
    const dir = winVendorTripleDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    mkdirSync(join(dir, 'codex-path'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'codex.exe'), 'MZ\n');
    writeFileSync(join(dir, 'codex-package.json'), '{}\n'); // new 布局双条件
    writeFileSync(join(dir, 'codex-path', 'rg.exe'), 'MZ\n');
    const helperDir = join(dir, 'codex-path');
    const { prependBundledCodexPathDirs } = await import('../sdk-bridge/codex-binary');
    const env: Record<string, string> = { Path: 'C:\\Windows\\System32;C:\\Windows' };
    prependBundledCodexPathDirs(env, 'win32');
    // helper prepend 到原 Path（用 win32 路径分隔符 ; — 测试机 darwin join 用 / 但 delimiter 由
    // node:path 决定；此处只断言 key 选择 + helper 在最前，不依赖 delimiter 具体值）
    expect(env.Path.startsWith(helperDir)).toBe(true);
    expect(env.Path).toContain('C:\\Windows\\System32');
    // 关键：不新增 PATH key（避免双 key 分叉）
    expect(env.PATH).toBeUndefined();
  });

  it('prepend win32：env 同时有 Path 和 PATH → 只保留 Path、删除 PATH 变体', async () => {
    const dir = winVendorTripleDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    mkdirSync(join(dir, 'codex-path'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'codex.exe'), 'MZ\n');
    writeFileSync(join(dir, 'codex-package.json'), '{}\n'); // new 布局双条件
    writeFileSync(join(dir, 'codex-path', 'rg.exe'), 'MZ\n');
    const helperDir = join(dir, 'codex-path');
    const { prependBundledCodexPathDirs } = await import('../sdk-bridge/codex-binary');
    // pathEnvKey 优先选 'Path'（即便也有 'PATH'）
    const env: Record<string, string> = { Path: 'C:\\sys', PATH: 'C:\\stale' };
    prependBundledCodexPathDirs(env, 'win32');
    expect(env.Path.startsWith(helperDir)).toBe(true);
    expect(env.Path).toContain('C:\\sys');
    expect(env.PATH).toBeUndefined(); // 其他大小写变体被删
  });
});
