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

function stopInstalledApp() {
  for (const pattern of [
    'Agent Deck.app/Contents/MacOS/Agent Deck',
    'Agent Deck Helper',
  ]) {
    const result = spawnSync('/usr/bin/pkill', ['-f', pattern], { stdio: 'ignore' });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`pkill failed for ${pattern} with exit code ${result.status}`);
    }
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

function installPackagedApp(sourceApp) {
  rmSync(stagingApp, { recursive: true, force: true });
  rmSync(previousApp, { recursive: true, force: true });

  run('/usr/bin/ditto', [sourceApp, stagingApp]);
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', stagingApp]);
  run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', stagingApp]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagingApp]);

  stopInstalledApp();
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
  console.log(`Usage: pnpm install:local:mac

Build, validate, and install Agent Deck on macOS. After successful installation, the unpacked
build/dist/mac-*/Agent Deck.app is removed so Spotlight indexes only /Applications/Agent Deck.app.

If the running app must not be stopped, run pnpm dist:mac instead; packaging alone never installs.`);
}

export function main(args = process.argv.slice(2)) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    printHelp();
    return;
  }
  if (args.length > 0) throw new Error(`unexpected argument: ${args[0]}`);
  if (process.platform !== 'darwin') {
    throw new Error('local Agent Deck installation is supported only on macOS');
  }

  const sourceApp = packagedAppPath(repoRoot, process.arch);
  rmSync(distRoot, { recursive: true, force: true });
  run('pnpm', ['dist:mac']);
  if (!existsSync(sourceApp)) {
    throw new Error(`packaged application is missing after pnpm dist:mac: ${sourceApp}`);
  }
  installPackagedApp(sourceApp);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[local-install] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
