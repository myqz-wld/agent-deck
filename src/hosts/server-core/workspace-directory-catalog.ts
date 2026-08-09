import { opendirSync } from 'node:fs';

import {
  SESSION_CONSOLE_MAX_DIRECTORY_ENTRIES,
  parseWorkspaceDirectoryRef,
  type WorkspaceDirectoryEntryDto,
} from '@contracts/index';

import { resolveServerCoreWorkspaceDirectory } from './project-catalog';

const MAX_SCANNED_DIRECTORY_ENTRIES = 4_096;

export interface ServerCoreWorkspaceDirectoryPage {
  readonly directory: string;
  readonly directories: readonly WorkspaceDirectoryEntryDto[];
  readonly truncated: boolean;
}

/** Lists only canonical direct children while keeping absolute Workspace paths private. */
export function listServerCoreWorkspaceDirectories(
  directoryRef: string,
  workspaceRoot = '/workspaces',
): ServerCoreWorkspaceDirectoryPage {
  const directory = parseWorkspaceDirectoryRef(directoryRef);
  const canonical = resolveServerCoreWorkspaceDirectory(directory, workspaceRoot);
  const handle = opendirSync(canonical);
  const children: WorkspaceDirectoryEntryDto[] = [];
  let scanned = 0;
  let truncated = false;
  try {
    while (true) {
      const entry = handle.readSync();
      if (!entry) break;
      scanned += 1;
      if (scanned > MAX_SCANNED_DIRECTORY_ENTRIES) {
        truncated = true;
        break;
      }
      const child = directory === '.' ? entry.name : `${directory}/${entry.name}`;
      try {
        const safeChild = parseWorkspaceDirectoryRef(
          child,
          'workspace.directory.list.child',
        );
        resolveServerCoreWorkspaceDirectory(safeChild, workspaceRoot);
        children.push(Object.freeze({ directory: safeChild, name: entry.name }));
      } catch {
        // Files, symlinks, escaped paths, and unsafe names are never projected to the client.
      }
    }
  } finally {
    handle.closeSync();
  }
  children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  if (children.length > SESSION_CONSOLE_MAX_DIRECTORY_ENTRIES) truncated = true;
  return Object.freeze({
    directory,
    directories: Object.freeze(children.slice(0, SESSION_CONSOLE_MAX_DIRECTORY_ENTRIES)),
    truncated,
  });
}
