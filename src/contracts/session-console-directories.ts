import { isJsonObject } from './json';
import {
  SessionConsoleContractError,
  parseWorkspaceDirectoryRef,
} from './session-console-common';

export const SESSION_CONSOLE_MAX_DIRECTORY_ENTRIES = 200;
export const SESSION_CONSOLE_MAX_DIRECTORY_NAME_BYTES = 255;

export interface WorkspaceDirectoryListParams {
  directory: string;
}

export interface WorkspaceDirectoryEntryDto {
  directory: string;
  name: string;
}

export interface WorkspaceDirectoryListResult {
  directory: string;
  directories: WorkspaceDirectoryEntryDto[];
  truncated: boolean;
  revision: number;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function compareDirectoryNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(field: string): never {
  throw new SessionConsoleContractError(field);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(field);
  }
}

function directoryName(value: unknown, field: string): string {
  if (
    typeof value !== 'string' || !value || value === '.' || value === '..' ||
    value.includes('/') || value.includes('\\') || CONTROL.test(value) ||
    new TextEncoder().encode(value).byteLength > SESSION_CONSOLE_MAX_DIRECTORY_NAME_BYTES
  ) fail(field);
  return value;
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail('workspace.directory.list.revision');
  return value as number;
}

export function parseWorkspaceDirectoryListParams(value: unknown): WorkspaceDirectoryListParams {
  if (!isJsonObject(value)) fail('workspace.directory.list.params');
  exactKeys(value, ['directory'], 'workspace.directory.list.params');
  return {
    directory: parseWorkspaceDirectoryRef(value.directory, 'workspace.directory.list.directory'),
  };
}

export function parseWorkspaceDirectoryListResult(
  value: unknown,
  requestedDirectory?: string,
): WorkspaceDirectoryListResult {
  if (!isJsonObject(value)) fail('workspace.directory.list.result');
  exactKeys(
    value,
    ['directories', 'directory', 'revision', 'truncated'],
    'workspace.directory.list.result',
  );
  const directory = parseWorkspaceDirectoryRef(
    value.directory,
    'workspace.directory.list.directory',
  );
  if (requestedDirectory !== undefined && directory !== requestedDirectory) {
    fail('workspace.directory.list.directory');
  }
  if (
    !Array.isArray(value.directories) ||
    value.directories.length > SESSION_CONSOLE_MAX_DIRECTORY_ENTRIES ||
    typeof value.truncated !== 'boolean'
  ) fail('workspace.directory.list.directories');
  const directories = value.directories.map((entry, index) => {
    const field = `workspace.directory.list.directories[${index}]`;
    if (!isJsonObject(entry)) fail(field);
    exactKeys(entry, ['directory', 'name'], field);
    const name = directoryName(entry.name, `${field}.name`);
    const child = parseWorkspaceDirectoryRef(entry.directory, `${field}.directory`);
    const expected = directory === '.' ? name : `${directory}/${name}`;
    if (child !== expected) fail(`${field}.directory`);
    return { directory: child, name };
  });
  if (
    new Set(directories.map((entry) => entry.directory)).size !== directories.length ||
    directories.some((entry, index) => index > 0 &&
      compareDirectoryNames(directories[index - 1]!.name, entry.name) >= 0)
  ) fail('workspace.directory.list.directories');
  return { directory, directories, truncated: value.truncated, revision: revision(value.revision) };
}
