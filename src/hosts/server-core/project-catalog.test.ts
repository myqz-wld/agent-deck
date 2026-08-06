import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  publicServerCoreProject,
  resolveServerCoreProjectCatalog,
  resolveServerCoreProjectWorkspace,
} from './project-catalog';

const roots: string[] = [];

function workspace(): { root: string; project: string } {
  const parent = mkdtempSync(join(tmpdir(), 'agent-deck-project-catalog-'));
  roots.push(parent);
  const root = join(parent, 'workspaces');
  const project = join(root, 'alpha');
  mkdirSync(project, { recursive: true });
  return { root, project };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Server Core project catalog', () => {
  it('keeps workspace paths private while resolving exact configured projects', () => {
    const paths = workspace();
    const catalog = resolveServerCoreProjectCatalog({ projects: [{
      projectId: 'project-alpha',
      projectRef: 'opaque-alpha',
      alias: 'alpha',
      title: 'Project Alpha',
      workspacePath: paths.project,
    }] }, paths.root);

    expect(resolveServerCoreProjectWorkspace(catalog[0]!, paths.root)).toBe(
      realpathSync(paths.project),
    );
    expect(publicServerCoreProject(catalog[0]!)).toEqual({
      projectId: 'project-alpha',
      projectRef: 'opaque-alpha',
      alias: 'alpha',
      title: 'Project Alpha',
    });
    expect(publicServerCoreProject(catalog[0]!)).not.toHaveProperty('workspacePath');
  });

  it('rejects duplicate public identities and paths outside the workspace volume', () => {
    const paths = workspace();
    const duplicate = {
      projectId: 'same', projectRef: 'same-ref', alias: 'same-alias',
      title: null, workspacePath: paths.project,
    };
    expect(() => resolveServerCoreProjectCatalog({ projects: [duplicate, {
      ...duplicate,
      projectRef: 'other-ref',
      alias: 'other-alias',
    }] }, paths.root)).toThrow('duplicate projectId');
    expect(() => resolveServerCoreProjectCatalog({ projects: [{
      ...duplicate,
      workspacePath: join(paths.root, '..', 'escape'),
    }] }, paths.root)).toThrow('workspacePath is invalid');
  });

  it('rejects an exact project path replaced by a symlink', () => {
    const paths = workspace();
    const outside = join(paths.root, 'outside');
    mkdirSync(outside);
    const link = join(paths.root, 'linked');
    symlinkSync(outside, link);
    const catalog = resolveServerCoreProjectCatalog({ projects: [{
      projectId: 'linked', projectRef: 'linked-ref', alias: 'linked', title: null,
      workspacePath: link,
    }] }, paths.root);
    expect(() => resolveServerCoreProjectWorkspace(catalog[0]!, paths.root))
      .toThrow('workspace is unavailable');
  });

  it('requires an exact bounded record shape', () => {
    const paths = workspace();
    expect(() => resolveServerCoreProjectCatalog({ projects: [{
      projectId: 'alpha', projectRef: 'alpha-ref', alias: 'alpha', title: null,
      workspacePath: paths.project, cwd: '/secret',
    }] }, paths.root)).toThrow('projects.0 is invalid');
    expect(resolveServerCoreProjectCatalog({}, paths.root)).toEqual([]);
  });
});
