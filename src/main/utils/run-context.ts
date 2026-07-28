import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BUILD_INFO_MAX_BYTES = 16 * 1_024;

export type BuildInfoStatus =
  | 'ok'
  | 'partial'
  | 'missing'
  | 'invalid'
  | 'oversize'
  | 'unreadable';

export interface BuildIdentity {
  status: BuildInfoStatus;
  shortCommit: string | null;
  builtAt: string | null;
  dirty: boolean | null;
}

export interface ProcessStartupRecord {
  event: 'process-startup';
  runId: string;
  pid: number;
  appVersion: string;
  buildStatus: BuildInfoStatus;
  buildShortCommit: string | null;
  buildTimestamp: string | null;
  buildDirty: boolean | null;
  isPackaged: boolean;
  platform: string;
  arch: string;
  schemaUserVersion: number | null;
  configuredFileLogLevel: string;
}

const PROCESS_RUN_ID = randomUUID();

function emptyBuildIdentity(status: BuildInfoStatus): BuildIdentity {
  return {
    status,
    shortCommit: null,
    builtAt: null,
    dirty: null,
  };
}

function readBoundedFile(filePath: string): { status: BuildInfoStatus; text?: string } {
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return { status: code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    const buffer = Buffer.alloc(BUILD_INFO_MAX_BYTES + 1);
    const bytesRead = fs.readSync(
      descriptor,
      buffer,
      0,
      BUILD_INFO_MAX_BYTES + 1,
      0,
    );
    if (bytesRead > BUILD_INFO_MAX_BYTES) return { status: 'oversize' };
    return { status: 'ok', text: buffer.toString('utf8', 0, bytesRead) };
  } catch {
    return { status: 'unreadable' };
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch {
      // The caller still receives the read status; no raw path or OS error is exposed.
    }
  }
}

function validatedShortCommit(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[0-9a-f]{7,40}$/i.test(value)) return null;
  return value.slice(0, 12);
}

function validatedTimestamp(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  ) {
    return null;
  }
  return value;
}

export function loadBuildIdentity(options: {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
}): BuildIdentity {
  const root = options.isPackaged ? options.resourcesPath : options.appPath;
  if (!root || !path.isAbsolute(root)) return emptyBuildIdentity('unreadable');
  const filePath = options.isPackaged
    ? path.join(root, 'build-info.json')
    : path.join(root, 'build', 'build-info.json');
  const read = readBoundedFile(filePath);
  if (read.status !== 'ok' || read.text === undefined) {
    return emptyBuildIdentity(read.status);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return emptyBuildIdentity('invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return emptyBuildIdentity('invalid');
  }
  const record = parsed as Record<string, unknown>;
  const shortCommit = validatedShortCommit(record.shortCommit);
  const builtAt = validatedTimestamp(record.builtAt);
  const dirty = typeof record.dirty === 'boolean' ? record.dirty : null;
  const invalidKnownField =
    (record.shortCommit !== undefined &&
      record.shortCommit !== 'unknown' &&
      shortCommit === null) ||
    (record.builtAt !== undefined && builtAt === null) ||
    (record.dirty !== undefined && dirty === null);
  if (invalidKnownField) return emptyBuildIdentity('invalid');
  const status: BuildInfoStatus =
    shortCommit !== null && builtAt !== null && dirty !== null ? 'ok' : 'partial';
  return { status, shortCommit, builtAt, dirty };
}

export function getProcessRunId(): string {
  return PROCESS_RUN_ID;
}

export function readSchemaUserVersion(read: () => unknown): number | null {
  try {
    const value = read();
    return Number.isSafeInteger(value) && (value as number) >= 0
      ? value as number
      : null;
  } catch {
    return null;
  }
}

function boundedIdentity(value: string, maxLength: number): string {
  if (!value) return 'unknown';
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

export function createProcessStartupRecord(input: {
  runId: string;
  pid: number;
  appVersion: string;
  build: BuildIdentity;
  isPackaged: boolean;
  platform: string;
  arch: string;
  schemaUserVersion: number | null;
  configuredFileLogLevel: string;
}): ProcessStartupRecord {
  return {
    event: 'process-startup',
    runId: boundedIdentity(input.runId, 80),
    pid: Number.isSafeInteger(input.pid) && input.pid >= 0 ? input.pid : 0,
    appVersion: boundedIdentity(input.appVersion, 64),
    buildStatus: input.build.status,
    buildShortCommit: input.build.shortCommit,
    buildTimestamp: input.build.builtAt,
    buildDirty: input.build.dirty,
    isPackaged: input.isPackaged,
    platform: boundedIdentity(input.platform, 32),
    arch: boundedIdentity(input.arch, 32),
    schemaUserVersion:
      Number.isSafeInteger(input.schemaUserVersion) &&
      (input.schemaUserVersion as number) >= 0
        ? input.schemaUserVersion
        : null,
    configuredFileLogLevel: boundedIdentity(input.configuredFileLogLevel, 32),
  };
}
