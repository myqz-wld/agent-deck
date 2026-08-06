import { isAbsolute, normalize } from 'node:path';

const MAX_APPLICATION_PATH_BYTES = 4_096;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export interface ApplicationHostPaths {
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly resourcesPath: string;
  readonly userDataPath: string;
}

let installedPaths: Readonly<ApplicationHostPaths> | null = null;

function boundedAbsolutePath(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    Buffer.byteLength(value, 'utf8') === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_APPLICATION_PATH_BYTES ||
    CONTROL.test(value)
  ) {
    throw new Error(`${field} must be a bounded absolute host path`);
  }
  return normalize(value);
}

export function createApplicationHostPaths(value: ApplicationHostPaths): Readonly<ApplicationHostPaths> {
  if (!value || typeof value !== 'object' || typeof value.isPackaged !== 'boolean') {
    throw new Error('application host paths are invalid');
  }
  return Object.freeze({
    isPackaged: value.isPackaged,
    appPath: boundedAbsolutePath(value.appPath, 'appPath'),
    resourcesPath: boundedAbsolutePath(value.resourcesPath, 'resourcesPath'),
    userDataPath: boundedAbsolutePath(value.userDataPath, 'userDataPath'),
  });
}

function samePaths(
  left: Readonly<ApplicationHostPaths>,
  right: Readonly<ApplicationHostPaths>,
): boolean {
  return left.isPackaged === right.isPackaged &&
    left.appPath === right.appPath &&
    left.resourcesPath === right.resourcesPath &&
    left.userDataPath === right.userDataPath;
}

/** Install one immutable path identity for this application/Core process. */
export function installApplicationHostPaths(value: ApplicationHostPaths): void {
  const next = createApplicationHostPaths(value);
  if (installedPaths) {
    if (!samePaths(installedPaths, next)) {
      throw new Error('application host paths are already installed for another host');
    }
    return;
  }
  installedPaths = next;
}

export function getApplicationHostPaths(): Readonly<ApplicationHostPaths> {
  if (!installedPaths) {
    throw new Error('application host paths are not installed');
  }
  return installedPaths;
}
