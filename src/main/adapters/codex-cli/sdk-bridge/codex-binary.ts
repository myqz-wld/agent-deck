/**
 * Codex 二进制路径解析（CHANGELOG_52 Step 4a / 第三轮大文件拆分）。
 *
 * 抽自 codex-cli/sdk-bridge.ts 的 PLATFORM_BINARY_MAP + resolveBundledCodexBinary。
 *
 * 打包后绕开 SDK 内部的 `moduleRequire.resolve` 自己拼 vendored 二进制路径。
 *
 * 不绕的话：SDK `findCodexPath` 走 `moduleRequire.resolve('@openai/codex/package.json')` →
 * `createRequire(...).resolve('@openai/codex-darwin-arm64/package.json')` → join vendor 二进制路径
 * 链解析。Electron 的 require 把 `@openai/codex/package.json` 解析回的字符串是
 * `.../app.asar/node_modules/@openai/codex/package.json`，最终 `binaryPath` 也落在 asar 内。SDK 拿
 * 这个 path 直接 `child_process.spawn`；spawn 不走 asar 虚拟 fs，OS 系统 fork/exec 把 `app.asar`
 * （一个普通文件）当目录访问 → ENOTDIR。
 *
 * 修复策略：app.isPackaged 时，主进程自己按 `app.asar.unpacked` 拼真实路径，传给 SDK 的
 * `codexPathOverride` 短路 SDK 自己的 resolve。dev 模式 `process.resourcesPath` 指向 Electron
 * 自身 Resources（无对应 unpacked 结构），返回 null 让 SDK 走默认 resolve（dev 没 asar 没问题）。
 *
 * **vendor 双布局**（codex-sdk ≥ 0.135 改了 vendor 子目录名）：
 * - 新布局：二进制 `vendor/<triple>/bin/<binName>` + helper PATH `vendor/<triple>/codex-path/`（0.135+）
 * - 旧布局：二进制 `vendor/<triple>/codex/<binName>` + helper PATH `vendor/<triple>/path/`（≤ 0.134）
 * 与 SDK 内部 `resolveNativePackage` 同款双探测：先 new 后 legacy，跨 SDK 版本都稳。
 *
 * **pathDirs（bundled helper PATH）**：SDK 自己 resolve 二进制时会把 `<vendor>/codex-path`（内含
 * bundled ripgrep `rg` 等）prepend 进子进程 PATH（`prependPathDirs`）。但本模块走 `codexPathOverride`
 * 短路 SDK resolve → SDK 把 `pathDirs` 置空（CodexExec 构造：传了 executablePath 就 `pathDirs=[]`）→
 * bundled `rg` 不进子进程 PATH。caller（ensureCodex / pool）必须自己 `prependBundledCodexPathDirs`
 * 把 helper dir 注入传给 SDK 的 `env.PATH`，否则目标机系统 PATH 无 rg 时 codex 文件搜索类功能退化。
 *
 * 与 package.json 的 `build.asarUnpack`（@openai/codex* 系列）配合：unpack 把物理文件复制到
 * `app.asar.unpacked/node_modules/@openai/codex-darwin-arm64/vendor/...`，本函数定位到那里。
 */
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
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

/** packaged app 内 `<vendor>/<triple>` 目录绝对路径；dev / 不支持平台 → null。 */
function bundledVendorTripleDir(): string | null {
  if (!app.isPackaged) return null;
  const spec = PLATFORM_BINARY_MAP[`${process.platform}-${process.arch}`];
  if (!spec) return null;
  return join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@openai',
    spec.pkgDir,
    'vendor',
    spec.triple,
  );
}

export function resolveBundledCodexBinary(): string | null {
  const vendorTripleDir = bundledVendorTripleDir();
  if (!vendorTripleDir) return null;
  const spec = PLATFORM_BINARY_MAP[`${process.platform}-${process.arch}`];
  if (!spec) return null;
  // vendor 双布局（与 SDK resolveNativePackage 同款先 new 后 legacy）：
  // new (0.135+) = vendor/<triple>/bin/<binName>；legacy (≤0.134) = vendor/<triple>/codex/<binName>
  const newLayout = join(vendorTripleDir, 'bin', spec.binName);
  if (existsSync(newLayout)) return newLayout;
  const legacyLayout = join(vendorTripleDir, 'codex', spec.binName);
  if (existsSync(legacyLayout)) return legacyLayout;
  return null;
}

/**
 * bundled codex helper PATH 目录（含 ripgrep 等）。与二进制双布局对齐：new=codex-path / legacy=path。
 * 仅返回**实际存在**的目录（与 SDK `existingDirs` 同语义）；dev / 不支持平台 / 目录缺失 → []。
 */
export function resolveBundledCodexPathDirs(): string[] {
  const vendorTripleDir = bundledVendorTripleDir();
  if (!vendorTripleDir) return [];
  // 与 resolveBundledCodexBinary 双布局判定对齐：bin/ 存在 → new 布局用 codex-path/；否则 legacy path/
  const newBin = join(vendorTripleDir, 'bin', 'codex');
  const candidate = existsSync(newBin)
    ? join(vendorTripleDir, 'codex-path')
    : join(vendorTripleDir, 'path');
  return existsSync(candidate) ? [candidate] : [];
}

/**
 * 把 bundled codex helper dir prepend 进 env 的 PATH（in-place 改传入 env 对象）。
 * 复刻 SDK `prependPathDirs` 非-win32 行为：prepend pathDirs + 去重已存在条目。caller 在
 * `new Codex({ env })` 前调，补回 codexPathOverride 短路掉的 bundled helper PATH 注入。
 * dev / 无 bundled helper → no-op。
 */
export function prependBundledCodexPathDirs(env: Record<string, string>): void {
  const pathDirs = resolveBundledCodexPathDirs();
  if (pathDirs.length === 0) return;
  const existing = (env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => entry.length > 0 && !pathDirs.includes(entry));
  env.PATH = [...pathDirs, ...existing].join(delimiter);
}
