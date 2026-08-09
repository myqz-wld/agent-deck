import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SESSION_CONSOLE_MAX_DIRECTORY_ENTRIES } from '@contracts/index';

import { listServerCoreWorkspaceDirectories } from './workspace-directory-catalog';

const roots: string[] = [];

function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-workspace-list-')));
  roots.push(root);
  mkdirSync(join(root, 'alpha', 'nested'), { recursive: true });
  mkdirSync(join(root, 'Zed'));
  mkdirSync(join(root, 'zeta'));
  mkdirSync(join(root, 'éclair'));
  writeFileSync(join(root, 'file.txt'), 'not a directory');
  symlinkSync(join(root, '..'), join(root, 'escape'));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Server Core Workspace directory catalog', () => {
  it('projects only direct canonical directories as relative references', () => {
    const root = workspace();
    expect(listServerCoreWorkspaceDirectories('.', root)).toEqual({
      directory: '.',
      directories: [
        { directory: 'Zed', name: 'Zed' },
        { directory: 'alpha', name: 'alpha' },
        { directory: 'zeta', name: 'zeta' },
        { directory: 'éclair', name: 'éclair' },
      ],
      truncated: false,
    });
    expect(listServerCoreWorkspaceDirectories('alpha', root)).toEqual({
      directory: 'alpha',
      directories: [{ directory: 'alpha/nested', name: 'nested' }],
      truncated: false,
    });
    expect(JSON.stringify(listServerCoreWorkspaceDirectories('.', root))).not.toContain(root);
  });

  it('bounds one listing and reports truncation', () => {
    const root = workspace();
    for (let index = 0; index < SESSION_CONSOLE_MAX_DIRECTORY_ENTRIES + 5; index += 1) {
      mkdirSync(join(root, `bulk-${String(index).padStart(3, '0')}`));
    }
    const result = listServerCoreWorkspaceDirectories('.', root);
    expect(result.directories).toHaveLength(SESSION_CONSOLE_MAX_DIRECTORY_ENTRIES);
    expect(result.truncated).toBe(true);
    expect(result.directories.map((entry) => entry.name)).toEqual(
      [...result.directories.map((entry) => entry.name)].sort(),
    );
  });
});
