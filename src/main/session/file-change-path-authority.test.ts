import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  captureFileChangePath,
  type FileChangeCaptureFilesystem,
} from './file-change-path-authority';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'agent-deck-file-authority-'));
  roots.push(value);
  return value;
}

describe('file-change path authority capture', () => {
  it('reconstructs an ordinary deleted target from its canonical parent', () => {
    const cwd = join(root(), 'Workspace', 'repo');
    mkdirSync(cwd, { recursive: true });

    expect(captureFileChangePath(cwd, 'src/deleted.ts', false).authority)
      .toBe(join(realpathSync(cwd), 'src', 'deleted.ts'));
  });

  it('binds an existing symlink to its canonical target', () => {
    const base = root();
    const cwd = join(base, 'Workspace');
    const outside = join(base, 'private');
    mkdirSync(cwd);
    mkdirSync(outside);
    const secret = join(outside, 'secret.ts');
    writeFileSync(secret, 'secret');
    const alias = join(cwd, 'alias.ts');
    symlinkSync(secret, alias);

    expect(captureFileChangePath(cwd, alias, false).authority).toBe(realpathSync(secret));
  });

  it('captures text bytes from the same canonical identity stored as authority', () => {
    const cwd = join(root(), 'Workspace', 'repo');
    mkdirSync(cwd, { recursive: true });
    const target = join(cwd, 'file.ts');
    writeFileSync(target, 'safe-content');

    expect(captureFileChangePath(cwd, target, true)).toEqual({
      authority: realpathSync(target),
      afterSnapshot: 'safe-content',
    });
  });

  it('rejects an intermediate-directory swap before reading snapshot bytes', () => {
    const base = root();
    const cwd = join(base, 'Workspace', 'repo');
    const slot = join(cwd, 'slot');
    const parked = join(cwd, 'slot-safe');
    const outside = join(base, 'private');
    mkdirSync(slot, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(slot, 'file.ts'), 'safe-content');
    writeFileSync(join(outside, 'file.ts'), 'private-content');
    let reads = 0;
    let swapped = false;
    const fs: FileChangeCaptureFilesystem = {
      close: closeSync,
      fstat: fstatSync,
      lstat: lstatSync,
      open: (path, flags) => {
        if (!swapped) {
          swapped = true;
          renameSync(slot, parked);
          symlinkSync(outside, slot, 'dir');
        }
        return openSync(path, flags);
      },
      read: (descriptor) => {
        reads += 1;
        return readFileSync(descriptor, 'utf8');
      },
      realpath: realpathSync,
      stat: statSync,
    };

    expect(captureFileChangePath(cwd, join(slot, 'file.ts'), true, fs)).toEqual({
      authority: null,
      afterSnapshot: null,
    });
    expect(reads).toBe(0);
  });

  it('records an unavailable authority when cwd cannot be proven', () => {
    const captured = captureFileChangePath(
      '/definitely/missing/agent-deck-cwd',
      'deleted.ts',
      false,
    );
    expect(captured).toEqual({ authority: null, afterSnapshot: null });
  });
});
