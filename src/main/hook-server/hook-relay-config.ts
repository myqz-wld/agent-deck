import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
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

function writePrivateFile(path: string, content: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`${path} must be a regular private relay file`);
    }
    if (readFileSync(path, 'utf8') === content) {
      chmodSync(path, 0o600);
      return;
    }
  }

  const temporaryPath = `${path}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
  let temporaryExists = false;
  try {
    const fd = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    temporaryExists = true;
    try {
      writeFileSync(fd, content, { encoding: 'utf8' });
      fchmodSync(fd, 0o600);
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
