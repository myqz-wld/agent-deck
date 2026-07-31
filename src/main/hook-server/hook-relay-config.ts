import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface HookRelayConfigOptions {
  relayRoot: string;
  adapterId: 'claude-code' | 'codex-cli' | 'grok-build';
  event: string;
  port: number;
  token: string;
  route: string;
}

export type HookRelayConfigHealthIssue =
  | 'missing'
  | 'symbolic-link'
  | 'not-regular-file'
  | 'wrong-mode'
  | 'content-mismatch'
  | 'unreadable'
  | 'changed-during-inspection';

export interface HookRelayConfigHealth {
  path: string;
  healthy: boolean;
  actualMode: number | null;
  issues: HookRelayConfigHealthIssue[];
}

const PRIVATE_RELAY_MODE = 0o600;

export function hookRelayConfigPath(
  relayRoot: string,
  adapterId: HookRelayConfigOptions['adapterId'],
  event: string,
): string {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(event)) {
    throw new Error('hook relay requires a static event name');
  }
  return join(relayRoot, `${adapterId}-${event.toLowerCase()}.curlrc`);
}

function assertRelayInputs(options: HookRelayConfigOptions): void {
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error('hook relay requires a valid loopback port');
  }
  if (!/^[0-9a-f]{64}$/.test(options.token)) {
    throw new Error('hook relay requires a canonical 64-character bearer token');
  }
  if (!/^\/hook\/[a-z0-9/-]+$/.test(options.route)) {
    throw new Error('hook relay requires a static hook route');
  }
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(options.event)) {
    throw new Error('hook relay requires a static event name');
  }
}

function relayContent(options: HookRelayConfigOptions): string {
  return [
    '# Agent Deck private hook relay configuration. Contains a bearer token; mode must remain 0600.',
    'silent',
    'show-error',
    'fail-with-body',
    'max-time = 2',
    'request = "POST"',
    `url = "http://127.0.0.1:${options.port}${options.route}"`,
    'header = "Content-Type: application/json"',
    `header = "Authorization: Bearer ${options.token}"`,
    '',
  ].join('\n');
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function sameSnapshot(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode
  );
}

function addIssue(
  issues: HookRelayConfigHealthIssue[],
  issue: HookRelayConfigHealthIssue,
): void {
  if (!issues.includes(issue)) issues.push(issue);
}

/**
 * Inspect, without repairing, whether the expected relay file is safe and exactly current.
 * Exact content matching rejects omitted, changed, duplicated, or additional curl directives,
 * including changes to the loopback URL/route, bearer token, POST method, and two-second timeout.
 */
export function inspectHookRelayConfig(
  options: HookRelayConfigOptions,
): HookRelayConfigHealth {
  assertRelayInputs(options);
  const path = hookRelayConfigPath(
    options.relayRoot,
    options.adapterId,
    options.event,
  );
  const issues: HookRelayConfigHealthIssue[] = [];
  let linkStat: Stats;
  try {
    const current = lstatIfPresent(path);
    if (!current) {
      return { path, healthy: false, actualMode: null, issues: ['missing'] };
    }
    linkStat = current;
  } catch {
    return { path, healthy: false, actualMode: null, issues: ['unreadable'] };
  }

  if (linkStat.isSymbolicLink()) {
    return {
      path,
      healthy: false,
      actualMode: linkStat.mode & 0o7777,
      issues: ['symbolic-link'],
    };
  }
  if (!linkStat.isFile()) {
    return {
      path,
      healthy: false,
      actualMode: linkStat.mode & 0o7777,
      issues: ['not-regular-file'],
    };
  }

  let actualMode = linkStat.mode & 0o7777;
  if (actualMode !== PRIVATE_RELAY_MODE) addIssue(issues, 'wrong-mode');
  let fd: number | null = null;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        constants.O_NONBLOCK,
    );
    const openedStat = fstatSync(fd);
    if (!openedStat.isFile()) {
      addIssue(issues, 'not-regular-file');
      return { path, healthy: false, actualMode, issues };
    }
    if (openedStat.dev !== linkStat.dev || openedStat.ino !== linkStat.ino) {
      addIssue(issues, 'changed-during-inspection');
      return { path, healthy: false, actualMode, issues };
    }

    actualMode = openedStat.mode & 0o7777;
    if (actualMode !== PRIVATE_RELAY_MODE) addIssue(issues, 'wrong-mode');
    const expected = Buffer.from(relayContent(options), 'utf8');
    const actual = Buffer.alloc(expected.length + 1);
    let bytesRead = 0;
    while (bytesRead < actual.length) {
      const count = readSync(
        fd,
        actual,
        bytesRead,
        actual.length - bytesRead,
        null,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    const afterReadStat = fstatSync(fd);
    if (!sameSnapshot(openedStat, afterReadStat)) {
      addIssue(issues, 'changed-during-inspection');
    } else if (
      bytesRead !== expected.length ||
      !actual.subarray(0, bytesRead).equals(expected)
    ) {
      addIssue(issues, 'content-mismatch');
    }

    try {
      const finalLinkStat = lstatSync(path);
      if (
        finalLinkStat.isSymbolicLink() ||
        !finalLinkStat.isFile() ||
        !sameSnapshot(finalLinkStat, openedStat)
      ) {
        addIssue(issues, 'changed-during-inspection');
      }
    } catch {
      addIssue(issues, 'changed-during-inspection');
    }
  } catch {
    addIssue(issues, 'unreadable');
  } finally {
    if (fd !== null) closeSync(fd);
  }

  return { path, healthy: issues.length === 0, actualMode, issues };
}

function writePrivateFile(path: string, content: string): void {
  const existing = lstatIfPresent(path);
  if (existing) {
    const stat = existing;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`${path} must be a regular private relay file`);
    }
    if (readFileSync(path, 'utf8') === content) {
      chmodSync(path, PRIVATE_RELAY_MODE);
      return;
    }
  }

  const temporaryPath = `${path}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
  let temporaryExists = false;
  try {
    const fd = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      PRIVATE_RELAY_MODE,
    );
    temporaryExists = true;
    try {
      writeFileSync(fd, content, { encoding: 'utf8' });
      fchmodSync(fd, PRIVATE_RELAY_MODE);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporaryPath, path);
    temporaryExists = false;
  } finally {
    if (temporaryExists) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Best effort: never mask the original relay write error.
      }
    }
  }
}

export function prepareHookRelayConfig(options: HookRelayConfigOptions): string {
  assertRelayInputs(options);
  mkdirSync(options.relayRoot, { recursive: true, mode: 0o700 });
  chmodSync(options.relayRoot, 0o700);
  const path = hookRelayConfigPath(options.relayRoot, options.adapterId, options.event);
  writePrivateFile(path, relayContent(options));
  return path;
}
