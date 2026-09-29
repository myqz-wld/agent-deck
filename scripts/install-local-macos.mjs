#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertInstalledAppStopped, stopInstalledApp } from './local-macos-processes.mjs';

const PRODUCT_NAME = 'Agent Deck';
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const applicationsRoot = '/Applications';
const installedApp = resolve(applicationsRoot, `${PRODUCT_NAME}.app`);
const stagingApp = resolve(applicationsRoot, `.${PRODUCT_NAME}.installing.app`);
const previousApp = resolve(applicationsRoot, `.${PRODUCT_NAME}.previous.app`);
const cliLink = '/usr/local/bin/agent-deck';

export function macOutputDirectory(arch) {
  if (arch === 'arm64') return 'mac-arm64';
  if (arch === 'x64') return 'mac';
  throw new Error(`unsupported macOS architecture: ${arch}`);
}

export function packagedAppPath(root, arch) {
  return resolve(root, 'build/dist', macOutputDirectory(arch), `${PRODUCT_NAME}.app`);
}

export function clearPackagedAppForBuild(root, arch) {
  const sourceApp = packagedAppPath(root, arch);
  assertInstalledAppStopped(sourceApp);
  rmSync(sourceApp, { recursive: true, force: true });
}

export function assertPrebuiltBuildInfo(metadata, commit, status) {
  if (metadata?.name !== 'agent-deck' || metadata.dirty !== false ||
      !/^[a-f0-9]{40}$/.test(commit) || metadata.commit !== commit || status.trim() !== '') {
    throw new Error('预构建安装包必须来自当前干净提交；请重新运行 pnpm dist:mac。');
  }
}

export function resolvedSymlinkTarget(linkPath, target) {
  return isAbsolute(target) ? resolve(target) : resolve(dirname(linkPath), target);
}

export function symlinkMatches(linkPath, expectedTarget) {
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) return false;
    return resolvedSymlinkTarget(linkPath, readlinkSync(linkPath)) === resolve(expectedTarget);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function ensureCliLink(expectedTarget) {
  if (symlinkMatches(cliLink, expectedTarget)) {
    console.log(`[local-install] reusing ${cliLink}`);
    return;
  }

  try {
    if (existsSync(cliLink) || lstatSync(cliLink).isSymbolicLink()) {
      if (!lstatSync(cliLink).isSymbolicLink()) {
        throw new Error(`${cliLink} exists and is not a symbolic link`);
      }
      rmSync(cliLink);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  try {
    symlinkSync(expectedTarget, cliLink);
  } catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      throw new Error(
        `cannot update ${cliLink}; run: sudo ln -sf "${expectedTarget}" "${cliLink}"`,
      );
    }
    throw error;
  }
}

function validateInstalledApp() {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', installedApp]);
  const wrapperEnvironment = { ...process.env };
  delete wrapperEnvironment.ELECTRON_RUN_AS_NODE;
  run(
    resolve(installedApp, 'Contents/Resources/bin/agent-deck'),
    ['--check-installed'],
    { env: wrapperEnvironment },
  );
}

async function installPackagedApp(sourceApp, stopRunning) {
  rmSync(stagingApp, { recursive: true, force: true });
  rmSync(previousApp, { recursive: true, force: true });

  run('/usr/bin/ditto', [sourceApp, stagingApp]);
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', stagingApp]);
  run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', stagingApp]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagingApp]);

  if (stopRunning) await stopInstalledApp(installedApp);
  assertInstalledAppStopped(installedApp);
  if (existsSync(installedApp)) renameSync(installedApp, previousApp);
  renameSync(stagingApp, installedApp);

  try {
    ensureCliLink(resolve(installedApp, 'Contents/Resources/bin/agent-deck'));
    validateInstalledApp();
  } catch (error) {
    rmSync(installedApp, { recursive: true, force: true });
    if (existsSync(previousApp)) renameSync(previousApp, installedApp);
    throw error;
  }

  rmSync(previousApp, { recursive: true, force: true });
  rmSync(sourceApp, { recursive: true, force: true });
  console.log(`[local-install] installed ${installedApp}`);
  console.log('[local-install] removed the packaged .app; DMG artifacts remain in build/dist');
}

export function printHelp() {
  console.log(`用法：pnpm install:local:mac [--stop-running] [--prebuilt]

构建、验证并安装 macOS 版 Agent Deck。默认要求先退出应用；
--stop-running 明确允许退出 /Applications/Agent Deck.app，可能中断应用内的当前会话。
该选项会先请求正常退出，再按完整可执行路径、PID 和启动时间核实目标后发送 SIGTERM。
无法确认身份或退出超时会取消安装。
--prebuilt 安装已完成验证且匹配当前干净提交的 build/dist 安装包，跳过重复构建。

安装成功后删除 build/dist/mac-*/Agent Deck.app，保留 DMG。
构建不会删除 build/dist 中保留的历史安装包。
仅打包而不安装，请运行 pnpm dist:mac。`);
}

export function parseInstallArgs(args) {
  if (new Set(args).size !== args.length ||
      args.some((arg) => arg !== '--stop-running' && arg !== '--prebuilt')) {
    throw new Error(`无法识别参数：${args.join(' ')}；使用 --help 查看用法。`);
  }
  return { stopRunning: args.includes('--stop-running'), prebuilt: args.includes('--prebuilt') };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    printHelp();
    return;
  }
  const { stopRunning, prebuilt } = parseInstallArgs(args);
  if (process.platform !== 'darwin') {
    throw new Error('local Agent Deck installation is supported only on macOS');
  }
  if (!stopRunning) assertInstalledAppStopped(installedApp);

  const sourceApp = packagedAppPath(repoRoot, process.arch);
  if (prebuilt) {
    const git = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
    assertPrebuiltBuildInfo(
      JSON.parse(readFileSync(resolve(sourceApp, 'Contents/Resources/build-info.json'), 'utf8')),
      git(['rev-parse', 'HEAD']),
      git(['status', '--porcelain']),
    );
    run('pnpm', ['check:packaged-macos-worker-sandbox']);
  } else {
    clearPackagedAppForBuild(repoRoot, process.arch);
    run('pnpm', ['dist:mac']);
  }
  if (!existsSync(sourceApp)) {
    throw new Error(`packaged application is missing after pnpm dist:mac: ${sourceApp}`);
  }
  await installPackagedApp(sourceApp, stopRunning);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[local-install] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
