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
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { app } from 'electron';
import type { BundledBinarySpec } from './types';

const requireFromHere = createRequire(__filename);

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
  const spec = currentPlatformSpec();
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

function currentPlatformSpec(): BundledBinarySpec | undefined {
  return PLATFORM_BINARY_MAP[`${process.platform}-${process.arch}`];
}

function unpackAsarPath(raw: string): string {
  return raw.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

function nodeModulesVendorTripleDir(): string | null {
  const spec = currentPlatformSpec();
  if (!spec) return null;
  try {
    const pkgJson = requireFromHere.resolve(`@openai/${spec.pkgDir}/package.json`);
    return unpackAsarPath(join(dirname(pkgJson), 'vendor', spec.triple));
  } catch {
    return null;
  }
}

/**
 * 是否 new 布局（0.135+）。与 SDK `resolveNativePackage` 同款**双条件**：`bin/<binName>` 是文件
 * **且** `codex-package.json` 是文件（batch-B reviewer-claude LOW —— 旧实现只判 bin/ 单条件，畸形
 * 布局「有 bin/codex 但无 codex-package.json」时会与 SDK 分叉：SDK fallback legacy 而本模块认 new）。
 * 用 isFile（statSync().isFile()）而非 existsSync 对齐 SDK（目录撞名也不误判）。
 */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isNewLayout(vendorTripleDir: string, binName: string): boolean {
  return (
    isFile(join(vendorTripleDir, 'bin', binName)) &&
    isFile(join(vendorTripleDir, 'codex-package.json'))
  );
}

export function resolveBundledCodexBinary(): string | null {
  const vendorTripleDir = bundledVendorTripleDir();
  if (!vendorTripleDir) return null;
  const spec = currentPlatformSpec();
  if (!spec) return null;
  // vendor 双布局（与 SDK resolveNativePackage 同款先 new 后 legacy）：
  // new (0.135+) = vendor/<triple>/bin/<binName> + codex-package.json；legacy (≤0.134) = vendor/<triple>/codex/<binName>
  if (isNewLayout(vendorTripleDir, spec.binName)) return join(vendorTripleDir, 'bin', spec.binName);
  const legacyLayout = join(vendorTripleDir, 'codex', spec.binName);
  if (isFile(legacyLayout)) return legacyLayout;
  return null;
}

export function resolveNodeModulesCodexBinary(): string | null {
  const vendorTripleDir = nodeModulesVendorTripleDir();
  if (!vendorTripleDir) return null;
  const spec = currentPlatformSpec();
  if (!spec) return null;
  if (isNewLayout(vendorTripleDir, spec.binName)) return join(vendorTripleDir, 'bin', spec.binName);
  const legacyLayout = join(vendorTripleDir, 'codex', spec.binName);
  if (isFile(legacyLayout)) return legacyLayout;
  return null;
}

export function resolveCodexBinary(): string | null {
  return resolveBundledCodexBinary() ?? resolveNodeModulesCodexBinary();
}

/**
 * bundled codex helper PATH 目录（含 ripgrep 等）。与二进制双布局对齐：new=codex-path / legacy=path。
 * 仅返回**实际存在**的目录（与 SDK `existingDirs` 同语义）；dev / 不支持平台 / 目录缺失 → []。
 */
export function resolveBundledCodexPathDirs(): string[] {
  const vendorTripleDir = bundledVendorTripleDir();
  if (!vendorTripleDir) return [];
  const spec = currentPlatformSpec();
  if (!spec) return [];
  // 与 resolveBundledCodexBinary 共用 isNewLayout 双条件判定（new → codex-path/；legacy → path/）。
  // 必须用 spec.binName（win32 = codex.exe）—— 硬编码 'codex' 会让 win32 new 布局误判 legacy → 返 []。
  const candidate = isNewLayout(vendorTripleDir, spec.binName)
    ? join(vendorTripleDir, 'codex-path')
    : join(vendorTripleDir, 'path');
  return existsSync(candidate) ? [candidate] : [];
}

export function resolveNodeModulesCodexPathDirs(): string[] {
  const vendorTripleDir = nodeModulesVendorTripleDir();
  if (!vendorTripleDir) return [];
  const spec = currentPlatformSpec();
  if (!spec) return [];
  const candidate = isNewLayout(vendorTripleDir, spec.binName)
    ? join(vendorTripleDir, 'codex-path')
    : join(vendorTripleDir, 'path');
  return existsSync(candidate) ? [candidate] : [];
}

export function resolveCodexPathDirs(): string[] {
  const bundled = resolveBundledCodexPathDirs();
  if (bundled.length > 0) return bundled;
  return resolveNodeModulesCodexPathDirs();
}

/**
 * 选 env 里的 PATH key。复刻 SDK `pathEnvKey`：非 win32 恒 `PATH`；win32 env key 大小写不敏感，
 * 实际 key 常是 `Path`（也可能 `PATH` / 其他 casing）→ 选已存在的（优先 `Path`，否则最后一个匹配的，
 * 都没有才 `PATH`），保证注入到 codex 子进程实际读的那个 key。
 */
function pathEnvKey(env: Record<string, string>, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return 'PATH';
  const matching = Object.keys(env).filter((k) => k.toLowerCase() === 'path');
  return matching.includes('Path') ? 'Path' : (matching.at(-1) ?? 'PATH');
}

/**
 * 把 bundled codex helper dir prepend 进 env 的 PATH（in-place 改传入 env 对象）。
 * 复刻 SDK `prependPathDirs`（含 win32 语义，batch-B reviewer-codex MED）：
 * - 选对 PATH key（pathEnvKey）—— win32 实际 key 是 `Path` 而非 `PATH`，写错 key 会产生双 key 分叉
 *   （helper 写进 `PATH` 但子进程读 `Path` 系统原值 → bundled rg 不生效）。
 * - win32 删除其他大小写变体的 path key（SDK 同款 — 只保留 pathKey 一个，避免重复 key 行为未定义）。
 * - prepend pathDirs + 去重已存在条目。
 * caller 在 `new Codex({ env })` 前调，补回 codexPathOverride 短路掉的 bundled helper PATH 注入。
 * dev / 无 bundled helper → no-op。
 */
export function prependBundledCodexPathDirs(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): void {
  const pathDirs = resolveBundledCodexPathDirs();
  prependCodexPathDirs(env, pathDirs, platform);
}

export function prependResolvedCodexPathDirs(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): void {
  const pathDirs = resolveCodexPathDirs();
  prependCodexPathDirs(env, pathDirs, platform);
}

function prependCodexPathDirs(
  env: Record<string, string>,
  pathDirs: string[],
  platform: NodeJS.Platform,
): void {
  if (pathDirs.length === 0) return;
  const pathKey = pathEnvKey(env, platform);
  if (platform === 'win32') {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path' && key !== pathKey) delete env[key];
    }
  }
  const existing = (env[pathKey] ?? '')
    .split(delimiter)
    .filter((entry) => entry.length > 0 && !pathDirs.includes(entry));
  env[pathKey] = [...pathDirs, ...existing].join(delimiter);
}
