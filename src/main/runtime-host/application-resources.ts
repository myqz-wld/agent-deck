import { join } from 'node:path';

import {
  getApplicationHostPaths,
  type ApplicationHostPaths,
} from './application-paths';

/** Resolve the app-owned resources root for either a development or packaged Node host. */
export function resolveApplicationResourcesRoot(paths: ApplicationHostPaths): string {
  return paths.isPackaged ? paths.resourcesPath : join(paths.appPath, 'resources');
}

export function getApplicationResourcesRoot(): string {
  return resolveApplicationResourcesRoot(getApplicationHostPaths());
}
