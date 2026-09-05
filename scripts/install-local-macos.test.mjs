import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'vitest';

import {
  macOutputDirectory,
  packagedAppPath,
  resolvedSymlinkTarget,
  symlinkMatches,
} from './install-local-macos.mjs';

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('local macOS install paths', () => {
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
