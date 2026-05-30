/**
 * codex-binary.ts vendor 双布局回归测试（codex-sdk 0.131 → 0.135 升级踩坑）。
 *
 * **背景**：codex-sdk ≥ 0.135 把 vendored 二进制从 `vendor/<triple>/codex/codex` 挪到
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
// （resolveBundledCodexBinary 读 process.resourcesPath）
const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

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
  (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = FIXTURE_ROOT;
});

afterAll(() => {
  if (existsSync(FIXTURE_ROOT)) rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = originalResourcesPath;
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
    writeFileSync(join(dir, 'codex', 'codex'), '#!/bin/sh\n');
    const { resolveBundledCodexBinary } = await import('../sdk-bridge/codex-binary');
    expect(resolveBundledCodexBinary()).toBe(join(dir, 'bin', 'codex'));
  });
});
