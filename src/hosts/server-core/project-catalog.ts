import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';

import {
  isJsonObject,
  parseWorkspaceDirectoryRef,
  type JsonObject,
} from '@contracts/index';
import type { ProjectReferenceDto } from '@contracts/session-console';

const MAX_PROJECTS = 256;
const MAX_TOKEN_BYTES = 256;
const MAX_TITLE_BYTES = 512;
const MAX_PATH_BYTES = 4_096;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export interface ServerCoreProject extends ProjectReferenceDto {
  readonly workspacePath: string;
}

function fail(field: string): never {
  throw new Error(`runtimeOptions.projects.${field} is invalid`);
}

function token(value: unknown, field: string): string {
  if (
    typeof value !== 'string' || value.length === 0 ||
    Buffer.byteLength(value) > MAX_TOKEN_BYTES || !SAFE_TOKEN.test(value)
  ) {
    fail(field);
  }
  return value;
}

function title(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' || Buffer.byteLength(value) > MAX_TITLE_BYTES ||
    CONTROL.test(value)
  ) {
    fail(field);
  }
  return value;
}

function workspacePath(value: unknown, field: string, workspaceRoot: string): string {
  if (
    typeof value !== 'string' || !isAbsolute(value) || normalize(value) !== value ||
    Buffer.byteLength(value) > MAX_PATH_BYTES || CONTROL.test(value)
  ) {
    fail(field);
  }
  const relation = relative(workspaceRoot, value);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    fail(field);
  }
  return value;
}

function exactProject(value: JsonObject, index: number, workspaceRoot: string): ServerCoreProject {
  const expected = ['alias', 'projectId', 'projectRef', 'title', 'workspacePath'];
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, offset) => key !== expected[offset])) {
    fail(String(index));
  }
  return Object.freeze({
    projectId: token(value.projectId, `${index}.projectId`),
    projectRef: parseWorkspaceDirectoryRef(value.projectRef, `${index}.projectRef`),
    alias: token(value.alias, `${index}.alias`),
    title: title(value.title, `${index}.title`),
    workspacePath: workspacePath(value.workspacePath, `${index}.workspacePath`, workspaceRoot),
  });
}

/** Validates the cwd-private catalog; only the DTO projection is ever returned to a client. */
export function resolveServerCoreProjectCatalog(
  runtimeOptions: JsonObject,
  workspaceRoot = '/workspaces',
): readonly ServerCoreProject[] {
  if (!isAbsolute(workspaceRoot) || normalize(workspaceRoot) !== workspaceRoot) {
    throw new Error('Server Core workspace root is invalid');
  }
  const raw = runtimeOptions.projects;
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw) || raw.length > MAX_PROJECTS) {
    throw new Error('runtimeOptions.projects must be a bounded array');
  }
  const projects = raw.map((value, index) => {
    if (!isJsonObject(value)) fail(String(index));
    return exactProject(value, index, workspaceRoot);
  });
  for (const key of ['projectId', 'projectRef', 'alias'] as const) {
    if (new Set(projects.map((project) => project[key])).size !== projects.length) {
      throw new Error(`runtimeOptions.projects contains duplicate ${key}`);
    }
  }
  return Object.freeze(projects);
}

/** Adds the authorized root as a user-selectable default without constraining nested directories. */
export function withServerCoreWorkspaceRootProject(
  projects: readonly ServerCoreProject[],
  workspaceRoot: string,
): readonly ServerCoreProject[] {
  if (projects.some((project) => project.workspacePath === workspaceRoot)) return projects;
  if (projects.some((project) =>
    project.projectId === 'agent-deck-workspace-root' || project.alias === 'workspace')) {
    throw new Error('runtimeOptions.projects conflicts with the reserved workspace root');
  }
  return Object.freeze([Object.freeze({
    projectId: 'agent-deck-workspace-root',
    projectRef: '.',
    alias: 'workspace',
    title: null,
    workspacePath: workspaceRoot,
  }), ...projects]);
}

/** Re-resolves the configured directory at use time and rejects symlink/path replacement. */
export function resolveServerCoreProjectWorkspace(
  project: ServerCoreProject,
  workspaceRoot = '/workspaces',
): string {
  const expected = resolve(project.workspacePath);
  const entry = lstatSync(expected);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('Server Core project workspace is unavailable');
  }
  const canonicalRoot = realpathSync(workspaceRoot);
  const canonical = realpathSync(expected);
  const relation = relative(canonicalRoot, canonical);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error('Server Core project workspace escaped its root');
  }
  return canonical;
}

/** Resolves one client-selected relative directory under the authoritative Workspace root. */
export function resolveServerCoreWorkspaceDirectory(
  directoryRef: string,
  workspaceRoot = '/workspaces',
): string {
  const reference = parseWorkspaceDirectoryRef(directoryRef);
  const expected = reference === '.' ? workspaceRoot : resolve(workspaceRoot, reference);
  const entry = lstatSync(expected);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('Server Core working directory is unavailable');
  }
  const canonicalRoot = realpathSync(workspaceRoot);
  const canonical = realpathSync(expected);
  const relation = relative(canonicalRoot, canonical);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error('Server Core working directory escaped its Workspace');
  }
  return canonical;
}

export function publicServerCoreProject(project: ServerCoreProject): ProjectReferenceDto {
  return Object.freeze({
    projectId: project.projectId,
    projectRef: project.projectRef,
    alias: project.alias,
    title: project.title,
  });
}
