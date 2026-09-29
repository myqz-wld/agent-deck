import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'vitest';

import {
  macOutputDirectory,
  clearPackagedAppForBuild,
  assertPrebuiltBuildInfo,
  packagedAppPath,
  parseInstallArgs,
  resolvedSymlinkTarget,
  symlinkMatches,
} from './install-local-macos.mjs';

const temporaryRoots = [];

describe('local macOS install authorization', () => {
  it('requires an explicit option before stopping the installed app', () => {
    assert.deepEqual(parseInstallArgs([]), { stopRunning: false, prebuilt: false });
    assert.deepEqual(parseInstallArgs(['--stop-running']), { stopRunning: true, prebuilt: false });
    assert.deepEqual(parseInstallArgs(['--prebuilt']), { stopRunning: false, prebuilt: true });
    assert.deepEqual(parseInstallArgs(['--prebuilt', '--stop-running']), { stopRunning: true, prebuilt: true });
    assert.throws(() => parseInstallArgs(['--force']), /无法识别参数/);
    assert.throws(() => parseInstallArgs(['--stop-running', '--stop-running']), /无法识别参数/);
  });

  it('rejects stale or dirty prebuilt releases before stopping the installed app', () => {
    const commit = 'a'.repeat(40);
    const metadata = { name: 'agent-deck', commit, dirty: false };
    assert.doesNotThrow(() => assertPrebuiltBuildInfo(metadata, commit, ''));
    for (const [info, head, status] of [
      [{ ...metadata, dirty: true }, commit, ''],
      [metadata, 'b'.repeat(40), ''],
      [metadata, commit, ' M source.ts'],
      [null, commit, ''],
    ]) assert.throws(() => assertPrebuiltBuildInfo(info, head, status), /当前干净提交/);
  });
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('local macOS install paths', () => {
  it('cleans the generated app while preserving retained installers and their checksums', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-local-retention-'));
    temporaryRoots.push(root);
    const app = packagedAppPath(root, 'arm64');
    const retained = join(root, 'build/dist/installed-fixture');
    mkdirSync(app, { recursive: true });
    mkdirSync(retained, { recursive: true });
    writeFileSync(join(retained, 'app.dmg'), 'fixture');
    writeFileSync(join(retained, 'SHA256SUMS'), 'fixture');
    clearPackagedAppForBuild(root, 'arm64');
    assert.equal(existsSync(app), false);
    assert.equal(existsSync(join(retained, 'app.dmg')), true);
    assert.equal(existsSync(join(retained, 'SHA256SUMS')), true);
  });
  it('selects the electron-builder output directory for each supported architecture', () => {
    assert.equal(macOutputDirectory('arm64'), 'mac-arm64');
    assert.equal(macOutputDirectory('x64'), 'mac');
    assert.throws(() => macOutputDirectory('riscv64'), /unsupported macOS architecture/);
  });

  it('resolves the packaged app below build/dist', () => {
    assert.equal(
      packagedAppPath('/repo', 'arm64'),
      resolve('/repo/build/dist/mac-arm64/Agent Deck.app'),
    );
  });
});

describe('local macOS CLI symlink detection', () => {
  it('normalizes relative link targets', () => {
    assert.equal(
      resolvedSymlinkTarget('/usr/local/bin/agent-deck', '../../../Applications/Agent Deck.app'),
      '/Applications/Agent Deck.app',
    );
  });

  it('recognizes an existing link to the installed wrapper', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-local-install-'));
    temporaryRoots.push(root);
    const target = join(root, 'Agent Deck.app/Contents/Resources/bin/agent-deck');
    const link = join(root, 'agent-deck');
    mkdirSync(join(root, 'Agent Deck.app/Contents/Resources/bin'), { recursive: true });
    writeFileSync(target, '');
    symlinkSync(target, link);

    assert.equal(symlinkMatches(link, target), true);
    assert.equal(symlinkMatches(link, join(root, 'other')), false);
  });
});
