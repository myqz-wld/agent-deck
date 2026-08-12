import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { projectSessionFilePath } from './session-file-path-authority';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createRoot(): string {
  const value = mkdtempSync(join(realpathSync(tmpdir()), 'agent-deck-current-path-authority-'));
  roots.push(value);
  return value;
}

describe('session file path authority', () => {
  it('keeps a deleted target visible while its canonical ancestry is unchanged', () => {
    const workspace = join(createRoot(), 'Workspace');
    const cwd = join(workspace, 'repo');
    const slot = join(cwd, 'slot');
    mkdirSync(slot, { recursive: true });
    const deleted = join(slot, 'deleted.ts');
    const authority = join(realpathSync(slot), 'deleted.ts');

    expect(projectSessionFilePath({
      authority,
      canonicalize: realpathSync,
      cwd: realpathSync(cwd),
      filePath: deleted,
      workspaceRoot: realpathSync(workspace),
    })).toBe('repo/slot/deleted.ts');
  });

  it('rejects a deleted target after its nearest existing parent drifts outside Workspace', () => {
    const base = createRoot();
    const workspace = join(base, 'Workspace');
    const cwd = join(workspace, 'repo');
    const slot = join(cwd, 'slot');
    const parked = join(cwd, 'slot-safe');
    const outside = join(base, 'private');
    mkdirSync(slot, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const deleted = join(slot, 'deleted.ts');
    const authority = join(realpathSync(slot), 'deleted.ts');
    const canonicalCwd = realpathSync(cwd);
    const canonicalWorkspace = realpathSync(workspace);
    renameSync(slot, parked);
    symlinkSync(outside, slot, 'dir');

    expect(projectSessionFilePath({
      authority,
      canonicalize: realpathSync,
      cwd: canonicalCwd,
      filePath: deleted,
      workspaceRoot: canonicalWorkspace,
    })).toBeNull();
  });
});
