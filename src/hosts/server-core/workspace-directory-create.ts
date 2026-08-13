import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, relative, sep } from 'node:path';

import {
  parseWorkspaceDirectoryCreateParams,
  type WorkspaceDirectoryCreateParams,
} from '@contracts/index';

import { resolveServerCoreWorkspaceDirectory } from './project-catalog';

export interface WorkspaceDirectoryCreateFilesystem {
  close(descriptor: number): void;
  createChild(parent: string, name: string, expectedParent: Stats): CreatedDirectoryIdentity;
  fstat(descriptor: number): Stats;
  open(path: string, flags: number): number;
  realpath(path: string): string;
  removeChild(
    parent: string,
    name: string,
    expectedParent: Stats,
    expectedChild: CreatedDirectoryIdentity,
  ): void;
  stat(path: string): Stats;
}

interface CreatedDirectoryIdentity {
  dev: string;
  ino: string;
}

const CREATE_CHILD_SCRIPT = String.raw`
const fs = require('node:fs');
const [name, expectedDev, expectedIno] = process.argv.slice(1);
const reply = (value) => process.stdout.write(JSON.stringify(value));
try {
  const parent = fs.statSync('.');
  if (String(parent.dev) !== expectedDev || String(parent.ino) !== expectedIno) {
    throw Object.assign(new Error('parent changed'), { code: 'ESTALE' });
  }
  fs.mkdirSync(name, { mode: 0o755 });
  const descriptor = fs.openSync(
    name,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const child = fs.fstatSync(descriptor);
    if (!child.isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    reply({ ok: true, dev: String(child.dev), ino: String(child.ino) });
  } finally {
    fs.closeSync(descriptor);
  }
} catch (error) {
  reply({ ok: false, code: typeof error?.code === 'string' ? error.code : 'EIO' });
  process.exitCode = 1;
}
`;

const REMOVE_CHILD_SCRIPT = String.raw`
const fs = require('node:fs');
const [name, expectedParentDev, expectedParentIno, expectedChildDev, expectedChildIno] =
  process.argv.slice(1);
try {
  const parent = fs.statSync('.');
  if (String(parent.dev) !== expectedParentDev || String(parent.ino) !== expectedParentIno) {
    process.exitCode = 1;
  } else {
    const descriptor = fs.openSync(
      name,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW || 0),
    );
    let matches = false;
    try {
      const child = fs.fstatSync(descriptor);
      matches = String(child.dev) === expectedChildDev && String(child.ino) === expectedChildIno;
    } finally {
      fs.closeSync(descriptor);
    }
    if (!matches) process.exitCode = 1;
    else fs.rmdirSync(name);
  }
} catch {
  process.exitCode = 1;
}
`;

function createChildDirectory(
  parent: string,
  name: string,
  expectedParent: Stats,
): CreatedDirectoryIdentity {
  const result = spawnSync(process.execPath, [
    '--input-type=commonjs',
    '-e',
    CREATE_CHILD_SCRIPT,
    name,
    String(expectedParent.dev),
    String(expectedParent.ino),
  ], {
    cwd: parent,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    maxBuffer: 4_096,
    timeout: 5_000,
  });
  let response: unknown;
  try { response = JSON.parse(result.stdout); } catch {}
  if (
    result.status === 0 && response && typeof response === 'object' &&
    Reflect.get(response, 'ok') === true && typeof Reflect.get(response, 'dev') === 'string' &&
    typeof Reflect.get(response, 'ino') === 'string'
  ) {
    return {
      dev: Reflect.get(response, 'dev') as string,
      ino: Reflect.get(response, 'ino') as string,
    };
  }
  const code = response && typeof response === 'object' &&
    typeof Reflect.get(response, 'code') === 'string'
    ? Reflect.get(response, 'code') as string
    : (result.error as NodeJS.ErrnoException | undefined)?.code ?? 'EIO';
  const error = new Error('Workspace directory could not be created') as NodeJS.ErrnoException;
  error.code = code;
  throw error;
}

function removeChildDirectory(
  parent: string,
  name: string,
  expectedParent: Stats,
  expectedChild: CreatedDirectoryIdentity,
): void {
  const result = spawnSync(process.execPath, [
    '--input-type=commonjs',
    '-e',
    REMOVE_CHILD_SCRIPT,
    name,
    String(expectedParent.dev),
    String(expectedParent.ino),
    expectedChild.dev,
    expectedChild.ino,
  ], {
    cwd: parent,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 5_000,
  });
  if (result.status !== 0) throw new Error('Created Workspace directory could not be rolled back');
}

const filesystem: WorkspaceDirectoryCreateFilesystem = {
  close: closeSync,
  createChild: createChildDirectory,
  fstat: fstatSync,
  open: openSync,
  realpath: realpathSync,
  removeChild: removeChildDirectory,
  stat: statSync,
};

function inside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === '' || (
    relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
  );
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function matchesCreatedIdentity(stats: Stats, identity: CreatedDirectoryIdentity): boolean {
  return String(stats.dev) === identity.dev && String(stats.ino) === identity.ino;
}

/** Creates exactly one direct child and verifies the opened child before returning its public ref. */
export function createServerCoreWorkspaceDirectory(
  value: WorkspaceDirectoryCreateParams,
  workspaceRoot = '/workspaces',
  fs: WorkspaceDirectoryCreateFilesystem = filesystem,
): string {
  const params = parseWorkspaceDirectoryCreateParams(value);
  const expectedRef = params.parentDirectory === '.'
    ? params.name
    : `${params.parentDirectory}/${params.name}`;
  const canonicalRoot = fs.realpath(workspaceRoot);
  const canonicalParent = resolveServerCoreWorkspaceDirectory(
    params.parentDirectory,
    workspaceRoot,
  );
  let parentDescriptor: number | null = null;
  let childDescriptor: number | null = null;
  let openedParent: Stats | null = null;
  let createdIdentity: CreatedDirectoryIdentity | null = null;
  let accepted = false;
  try {
    parentDescriptor = fs.open(
      canonicalParent,
      constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
    );
    openedParent = fs.fstat(parentDescriptor);
    const currentParent = fs.realpath(canonicalParent);
    const currentParentStat = fs.stat(currentParent);
    if (
      !openedParent.isDirectory() || !inside(canonicalRoot, currentParent) ||
      !sameFile(openedParent, currentParentStat)
    ) throw new Error('Workspace directory changed');

    // The child process first binds cwd to the parent, then compares that bound directory's
    // dev/ino before calling mkdir with a direct relative name. Ancestor replacement therefore
    // fails before the write instead of retargeting it outside Workspace. This is the portable
    // mkdirat equivalent available to both Node and Electron on macOS/Linux.
    createdIdentity = fs.createChild(canonicalParent, params.name, openedParent);
    const childPath = join(canonicalParent, params.name);
    childDescriptor = fs.open(
      childPath,
      constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
    );
    const openedChild = fs.fstat(childDescriptor);
    const currentRoot = fs.realpath(workspaceRoot);
    const currentParentAfterCreate = fs.realpath(canonicalParent);
    const currentParentAfterCreateStat = fs.stat(currentParentAfterCreate);
    const requestedChild = fs.realpath(childPath);
    const requestedStat = fs.stat(requestedChild);
    if (
      currentRoot !== canonicalRoot || currentParentAfterCreate !== canonicalParent ||
      !sameFile(openedParent, currentParentAfterCreateStat) ||
      !openedChild.isDirectory() || !inside(currentRoot, requestedChild) ||
      !sameFile(openedChild, requestedStat) ||
      !matchesCreatedIdentity(openedChild, createdIdentity)
    ) throw new Error('Created Workspace directory changed');
    accepted = true;
    return expectedRef;
  } finally {
    if (childDescriptor !== null) {
      try { fs.close(childDescriptor); } catch {}
    }
    if (parentDescriptor !== null) {
      try { fs.close(parentDescriptor); } catch {}
    }
    if (!accepted && createdIdentity !== null && openedParent !== null) {
      try { fs.removeChild(canonicalParent, params.name, openedParent, createdIdentity); } catch {}
    }
  }
}
