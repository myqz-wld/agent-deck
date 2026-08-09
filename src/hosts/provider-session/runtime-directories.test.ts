import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { prepareProviderSessionRuntimeDirectories } from './runtime-directories';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('Provider session runtime directory preparation', () => {
  it('recreates an absent exact private hierarchy with mode 0700', () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'ad-runtime-')));
    roots.push(root);
    const privateRoot = join(root, 'private');
    const paths = [privateRoot, join(privateRoot, 'state'), join(privateRoot, 'broker'),
      join(privateRoot, 'supervisor')];
    prepareProviderSessionRuntimeDirectories(paths);
    for (const path of paths) expect(lstatSync(path).mode & 0o777).toBe(0o700);
    rmSync(privateRoot, { recursive: true });
    prepareProviderSessionRuntimeDirectories(paths);
    expect(realpathSync(paths[3]!)).toBe(paths[3]);
  });

  it('fails closed for a symlink or widened existing directory', () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'ad-runtime-')));
    roots.push(root);
    const outside = join(root, 'outside');
    const linked = join(root, 'linked');
    prepareProviderSessionRuntimeDirectories([outside]);
    symlinkSync(outside, linked);
    expect(() => prepareProviderSessionRuntimeDirectories([linked])).toThrow('identity');
    chmodSync(outside, 0o755);
    expect(() => prepareProviderSessionRuntimeDirectories([outside])).toThrow('identity');
  });
});
