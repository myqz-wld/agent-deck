import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createServerCoreWorkspaceDirectory } from './workspace-directory-create';

const roots: string[] = [];

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `agent-deck-${label}-`));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('createServerCoreWorkspaceDirectory', () => {
  it('creates exactly one direct child and returns only its Workspace-relative reference', () => {
    const root = temporaryRoot('workspace-create');
    mkdirSync(join(root, 'repo'));
    expect(createServerCoreWorkspaceDirectory({
      parentDirectory: 'repo', name: 'new-folder',
    }, root)).toBe('repo/new-folder');
    expect(existsSync(join(root, 'repo', 'new-folder'))).toBe(true);
  });

  it('rejects duplicate names and symlinked parents', () => {
    const root = temporaryRoot('workspace-deny');
    const outside = temporaryRoot('workspace-outside');
    mkdirSync(join(root, 'repo'));
    mkdirSync(join(root, 'repo', 'existing'));
    expect(() => createServerCoreWorkspaceDirectory({
      parentDirectory: 'repo', name: 'existing',
    }, root)).toThrow();

    symlinkSync(outside, join(root, 'link'));
    expect(() => createServerCoreWorkspaceDirectory({
      parentDirectory: 'link', name: 'denied',
    }, root)).toThrow();
    expect(existsSync(join(outside, 'denied'))).toBe(false);
  });
});
