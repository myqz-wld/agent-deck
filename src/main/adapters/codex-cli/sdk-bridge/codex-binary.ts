/**
 * Codex 二进制路径解析（CHANGELOG_52 Step 4a / 第三轮大文件拆分）。
 *
 * 抽自 codex-cli/sdk-bridge.ts 的 PLATFORM_BINARY_MAP + resolveBundledCodexBinary。
 *
 * 打包后绕开 SDK 内部的 `moduleRequire.resolve` 自己拼 vendored 二进制路径。
 *
 * 不绕的话：SDK `findCodexPath` 走 `moduleRequire.resolve('@openai/codex/package.json')` →
 * `createRequire(...).resolve('@openai/codex-darwin-arm64/package.json')` → join 'vendor/.../codex/codex'
 * 链解析（dist/index.js:421-433）。Electron 的 require 把 `@openai/codex/package.json` 解析回的
 * 字符串是 `.../app.asar/node_modules/@openai/codex/package.json`，最终 `binaryPath` 也是
 * `.../app.asar/.../codex`。SDK 拿这个 path 直接 `child_process.spawn`（dist/index.js:238）；spawn
 * 不走 asar 虚拟 fs，OS 系统 fork/exec 把 `app.asar`（一个普通文件）当目录访问 → ENOTDIR。
 *
 * 修复策略：app.isPackaged 时，主进程自己按 `app.asar.unpacked` 拼真实路径，传给 SDK 的
 * `codexPathOverride` 短路 SDK 自己的 resolve。dev 模式 `process.resourcesPath` 指向 Electron
 * 自身 Resources（无对应 unpacked 结构），返回 null 让 SDK 走默认 resolve（dev 没 asar 没问题）。
 *
 * 与 package.json 的 `build.asarUnpack`（@openai/codex* 系列）配合：unpack 把物理文件复制到
 * `app.asar.unpacked/node_modules/@openai/codex-darwin-arm64/vendor/...`，本函数定位到那里。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { BundledBinarySpec } from './types';

const PLATFORM_BINARY_MAP: Record<string, BundledBinarySpec | undefined> = {
  'darwin-arm64': { pkgDir: 'codex-darwin-arm64', triple: 'aarch64-apple-darwin', binName: 'codex' },
  'darwin-x64': { pkgDir: 'codex-darwin-x64', triple: 'x86_64-apple-darwin', binName: 'codex' },
  'linux-arm64': {
    pkgDir: 'codex-linux-arm64',
    triple: 'aarch64-unknown-linux-musl',
    binName: 'codex',
  },
  'linux-x64': {
    pkgDir: 'codex-linux-x64',
    triple: 'x86_64-unknown-linux-musl',
    binName: 'codex',
  },
  'win32-arm64': {
    pkgDir: 'codex-win32-arm64',
    triple: 'aarch64-pc-windows-msvc',
    binName: 'codex.exe',
  },
  'win32-x64': {
    pkgDir: 'codex-win32-x64',
    triple: 'x86_64-pc-windows-msvc',
    binName: 'codex.exe',
  },
};

export function resolveBundledCodexBinary(): string | null {
  if (!app.isPackaged) return null;
  const spec = PLATFORM_BINARY_MAP[`${process.platform}-${process.arch}`];
  if (!spec) return null;
  const binPath = join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@openai',
    spec.pkgDir,
    'vendor',
    spec.triple,
    'codex',
    spec.binName,
  );
  return existsSync(binPath) ? binPath : null;
}
