#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
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
const distRoot = resolve(repoRoot, 'build/dist');
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
  console.log(`用法：pnpm install:local:mac [--stop-running]

构建、验证并安装 macOS 版 Agent Deck。默认要求先退出应用；
--stop-running 明确允许退出 /Applications/Agent Deck.app，可能中断应用内的当前会话。
该选项会先请求正常退出，再按完整可执行路径、PID 和启动时间核实目标后发送 SIGTERM。
无法确认身份或退出超时会取消安装。

安装成功后删除 build/dist/mac-*/Agent Deck.app，保留 DMG。
仅打包而不安装，请运行 pnpm dist:mac。`);
}

export function parseInstallArgs(args) {
  if (args.length === 0) return { stopRunning: false };
  if (args.length === 1 && args[0] === '--stop-running') return { stopRunning: true };
  throw new Error(`无法识别参数：${args.join(' ')}；使用 --help 查看用法。`);
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    printHelp();
    return;
  }
  const { stopRunning } = parseInstallArgs(args);
  if (process.platform !== 'darwin') {
    throw new Error('local Agent Deck installation is supported only on macOS');
  }
  if (!stopRunning) assertInstalledAppStopped(installedApp);

  const sourceApp = packagedAppPath(repoRoot, process.arch);
  rmSync(distRoot, { recursive: true, force: true });
  run('pnpm', ['dist:mac']);
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
