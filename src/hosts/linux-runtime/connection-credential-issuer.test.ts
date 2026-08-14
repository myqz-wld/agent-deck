import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  commitManagedTextTransaction,
  readTrustedTextFile,
} from './connection-credential-issuer';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('managed connection authority transaction', () => {
  it('preserves exact file ownership/mode and rolls back an earlier replacement on conflict', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-managed-files-')));
    roots.push(root);
    const firstPath = join(root, 'authority.json');
    const secondPath = join(root, 'authorized_keys');
    writeFileSync(firstPath, 'before-authority\n', { mode: 0o600 });
    writeFileSync(secondPath, 'before-keys\n', { mode: 0o600 });
    chmodSync(firstPath, 0o600);
    chmodSync(secondPath, 0o600);
    const first = readTrustedTextFile(firstPath);
    const second = readTrustedTextFile(secondPath);
    writeFileSync(secondPath, 'concurrent-change\n', { mode: 0o600 });

    expect(() => commitManagedTextTransaction({
      mutations: [
        { current: first, next: 'after-authority\n' },
        { current: second, next: 'after-keys\n' },
      ],
    })).toThrow('changed before');

    expect(readFileSync(firstPath, 'utf8')).toBe('before-authority\n');
    expect(statSync(firstPath)).toMatchObject({
      uid: first.uid,
      gid: first.gid,
    });
    expect(statSync(firstPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(secondPath, 'utf8')).toBe('concurrent-change\n');
  });
});
