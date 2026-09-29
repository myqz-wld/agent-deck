import { relative } from 'node:path';
import { findEventImage, loadEventImage } from '@main/store/event-image-repo';
import { isRemoteSensitiveWorkspacePath } from './remote-sensitive-data';
import type { ServerCoreSessionDetailRuntimeOptions } from './session-detail-runtime';

export function createEventImagePort(workspaceRoot: string): NonNullable<ServerCoreSessionDetailRuntimeOptions['eventImages']> {
  return {
    authorized: (sessionId, imageId) => findEventImage(sessionId, imageId) !== null,
    load: (sessionId, imageId) => loadEventImage(sessionId, imageId, workspaceRoot,
      (path) => !isRemoteSensitiveWorkspacePath(relative(workspaceRoot, path))),
  };
}
