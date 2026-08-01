/** Current packaged Codex binary and helper-path resolution. */
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

describe('resolveBundledCodexBinary current vendor layout', () => {
  it('dev 模式（!isPackaged）→ null（让 SDK 走自身 resolve）', async () => {
    electronState.isPackaged = false;
    const { resolveBundledCodexBinary } = await import('../sdk-bridge/codex-binary');
    expect(resolveBundledCodexBinary()).toBeNull();
    electronState.isPackaged = true;
  });

  it('布局缺失 → null（不瞎指路径）', async () => {
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

  it.runIf(isDarwinArm64)('current 布局 bin/codex → 命中', async () => {
    const dir = vendorTripleDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'codex'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'codex-package.json'), '{}\n');
    const { resolveBundledCodexBinary } = await import('../sdk-bridge/codex-binary');
    expect(resolveBundledCodexBinary()).toBe(join(dir, 'bin', 'codex'));
  });

  it.runIf(isDarwinArm64)('缺 codex-package.json → null', async () => {
    const dir = vendorTripleDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'codex'), '#!/bin/sh\n');
    const { resolveBundledCodexBinary } = await import('../sdk-bridge/codex-binary');
    expect(resolveBundledCodexBinary()).toBeNull();
  });
});

describe('resolveBundledCodexPathDirs / prependResolvedCodexPathDirs（bundled rg helper PATH）', () => {
  it('dev 模式 → bundled pathDirs []', async () => {
    electronState.isPackaged = false;
    const { resolveBundledCodexPathDirs } = await import('../sdk-bridge/codex-binary');
    expect(resolveBundledCodexPathDirs()).toEqual([]);
    electronState.isPackaged = true;
  });

  it.runIf(isDarwinArm64)('current 布局 → codex-path/ 作 pathDir + prepend 进 PATH', async () => {
    const dir = vendorTripleDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    mkdirSync(join(dir, 'codex-path'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'codex'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'codex-package.json'), '{}\n');
    writeFileSync(join(dir, 'codex-path', 'rg'), '#!/bin/sh\n');
    const { resolveBundledCodexPathDirs, prependResolvedCodexPathDirs } = await import(
      '../sdk-bridge/codex-binary'
    );
    const helperDir = join(dir, 'codex-path');
    expect(resolveBundledCodexPathDirs()).toEqual([helperDir]);
    const env = { PATH: '/usr/bin:/bin' };
    prependResolvedCodexPathDirs(env);
    expect(env.PATH).toBe(`${helperDir}:/usr/bin:/bin`);
  });

  it.runIf(isDarwinArm64)('prepend 去重已存在条目（不重复 prepend）', async () => {
    const dir = vendorTripleDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    mkdirSync(join(dir, 'codex-path'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'codex'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'codex-package.json'), '{}\n');
    writeFileSync(join(dir, 'codex-path', 'rg'), '#!/bin/sh\n');
    const { prependResolvedCodexPathDirs } = await import('../sdk-bridge/codex-binary');
    const helperDir = join(dir, 'codex-path');
    const env = { PATH: `${helperDir}:/usr/bin` }; // 已含 helperDir
    prependResolvedCodexPathDirs(env);
    expect(env.PATH).toBe(`${helperDir}:/usr/bin`); // 去重不重复
  });

  it.runIf(isDarwinArm64)('bin 在但 codex-path 缺 → pathDirs []（existingDirs 语义）', async () => {
    const dir = vendorTripleDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'codex'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'codex-package.json'), '{}\n');
    const { resolveBundledCodexPathDirs } = await import('../sdk-bridge/codex-binary');
    expect(resolveBundledCodexPathDirs()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试机非 win32，故 stub process.platform/arch 覆盖 codex.exe 与 Path 键语义。
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

  it('current 布局 bin/codex.exe + codex-path/ → 命中 codex-path', async () => {
    const dir = winVendorTripleDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    mkdirSync(join(dir, 'codex-path'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'codex.exe'), 'MZ\n'); // win32 binName 带 .exe
    writeFileSync(join(dir, 'codex-package.json'), '{}\n');
    writeFileSync(join(dir, 'codex-path', 'rg.exe'), 'MZ\n');
    const { resolveBundledCodexBinary, resolveBundledCodexPathDirs } = await import(
      '../sdk-bridge/codex-binary'
    );
    expect(resolveBundledCodexBinary()).toBe(join(dir, 'bin', 'codex.exe'));
    expect(resolveBundledCodexPathDirs()).toEqual([join(dir, 'codex-path')]);
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
    const { prependResolvedCodexPathDirs } = await import('../sdk-bridge/codex-binary');
    const env: Record<string, string> = { Path: 'C:\\Windows\\System32;C:\\Windows' };
    prependResolvedCodexPathDirs(env, 'win32');
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
    const { prependResolvedCodexPathDirs } = await import('../sdk-bridge/codex-binary');
    // pathEnvKey 优先选 'Path'（即便也有 'PATH'）
    const env: Record<string, string> = { Path: 'C:\\sys', PATH: 'C:\\stale' };
    prependResolvedCodexPathDirs(env, 'win32');
    expect(env.Path.startsWith(helperDir)).toBe(true);
    expect(env.Path).toContain('C:\\sys');
    expect(env.PATH).toBeUndefined(); // 其他大小写变体被删
  });
});
