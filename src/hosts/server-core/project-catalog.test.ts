import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  publicServerCoreProject,
  resolveServerCoreProjectCatalog,
  resolveServerCoreProjectWorkspace,
  resolveServerCoreWorkspaceDirectory,
  withServerCoreWorkspaceRootProject,
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
      projectRef: 'alpha',
      alias: 'alpha',
      title: 'Project Alpha',
      workspacePath: paths.project,
    }] }, paths.root);

    expect(resolveServerCoreProjectWorkspace(catalog[0]!, paths.root)).toBe(
      realpathSync(paths.project),
    );
    expect(publicServerCoreProject(catalog[0]!)).toEqual({
      projectId: 'project-alpha',
      projectRef: 'alpha',
      alias: 'alpha',
      title: 'Project Alpha',
    });
    expect(publicServerCoreProject(catalog[0]!)).not.toHaveProperty('workspacePath');
  });

  it('allows a single-project Worker to use the authorized workspace root itself', () => {
    const paths = workspace();
    const catalog = resolveServerCoreProjectCatalog({ projects: [{
      projectId: 'worker-workspace',
      projectRef: '.',
      alias: 'workspace',
      title: null,
      workspacePath: paths.root,
    }] }, paths.root);

    expect(resolveServerCoreProjectWorkspace(catalog[0]!, paths.root)).toBe(
      realpathSync(paths.root),
    );
  });

  it('publishes only a relative root suggestion and permits nested directory selection', () => {
    const paths = workspace();
    const nested = join(paths.project, 'nested');
    mkdirSync(nested);
    const catalog = withServerCoreWorkspaceRootProject([], paths.root);

    expect(catalog).toMatchObject([{
      projectId: 'agent-deck-workspace-root',
      projectRef: '.',
      alias: 'workspace',
      title: null,
    }]);
    expect(publicServerCoreProject(catalog[0]!)).not.toHaveProperty('workspacePath');
    expect(resolveServerCoreWorkspaceDirectory('alpha/nested', paths.root))
      .toBe(realpathSync(nested));
  });

  it('rejects absolute, parent, missing, and symlink working directories', () => {
    const paths = workspace();
    const outside = join(paths.root, '..', 'outside');
    mkdirSync(outside);
    const link = join(paths.root, 'escape-link');
    symlinkSync(outside, link);

    for (const reference of ['/etc', '../outside', 'alpha/../outside', 'missing']) {
      expect(() => resolveServerCoreWorkspaceDirectory(reference, paths.root)).toThrow();
    }
    expect(() => resolveServerCoreWorkspaceDirectory('escape-link', paths.root))
      .toThrow('unavailable');
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
