import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseRemoteConnectionCredential,
  type RemoteConnectionCredential,
  type RemoteHostRemoteTopology,
} from '@shared/remote-host';

import { requireAbsolutePath, requirePositiveInteger } from './validation';

const MAX_MANAGED_FILE_BYTES = 1024 * 1024;
const SSH_KEYGEN = '/usr/bin/ssh-keygen';

export interface RemoteConnectionIssueInput {
  readonly topology: RemoteHostRemoteTopology;
  readonly instanceId: string;
  readonly credentialId: string;
  readonly label: string;
  readonly hostname: string;
  readonly port: number;
  readonly username: string;
  readonly hostKeyFile: string;
  readonly outputFile: string;
}

export interface PreparedRemoteConnectionIssue {
  readonly credential: RemoteConnectionCredential;
  readonly clientPublicKey: string;
  readonly clientFingerprint: string;
  readonly encodedCredential: string;
}

export interface TrustedTextFile {
  readonly path: string;
  readonly text: string;
  readonly mode: number;
}

export interface CredentialIssueMutation {
  readonly current: TrustedTextFile;
  readonly next: string;
}

function keyParts(value: string, field: string): { algorithm: string; publicKey: string } {
  const [algorithm, publicKey] = value.trim().split(/\s+/u);
  if (!algorithm || !publicKey || !/^[A-Za-z0-9+/]+={0,3}$/u.test(publicKey)) {
    throw new Error(`${field} is not an OpenSSH public key`);
  }
  return { algorithm, publicKey };
}

function readSecretText(path: string): string {
  const bytes = readFileSync(path);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    bytes.fill(0);
  }
}

function fingerprint(publicKey: string): string {
  return `SHA256:${createHash('sha256')
    .update(Buffer.from(publicKey, 'base64'))
    .digest('base64')
    .replace(/=+$/u, '')}`;
}

export function prepareRemoteConnectionIssue(
  input: RemoteConnectionIssueInput,
): PreparedRemoteConnectionIssue {
  requireAbsolutePath(input.hostKeyFile, 'host-key');
  requireAbsolutePath(input.outputFile, 'output');
  requirePositiveInteger(input.port, 'port', 65_535);
  const outputParent = dirname(input.outputFile);
  if (realpathSync(outputParent) !== outputParent ||
      statSync(input.outputFile, { throwIfNoEntry: false }) !== undefined) {
    throw new Error('connection credential output path is not a new canonical file');
  }
  const tempRoot = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'agent-deck-issue-')));
  const identityPath = join(tempRoot, 'identity');
  try {
    execFileSync(SSH_KEYGEN, [
      '-q', '-t', 'ed25519', '-N', '', '-C', `agent-deck:${input.credentialId}`,
      '-f', identityPath,
    ], {
      env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const identityStat = lstatSync(identityPath);
    if (!identityStat.isFile() || identityStat.isSymbolicLink() ||
        (identityStat.mode & 0o777) !== 0o600) {
      throw new Error('generated SSH identity failed its trust check');
    }
    const privateKey = readSecretText(identityPath);
    const generated = keyParts(readFileSync(`${identityPath}.pub`, 'utf8'), 'generated key');
    if (generated.algorithm !== 'ssh-ed25519') throw new Error('generated key is not Ed25519');
    const host = keyParts(readTrustedTextFile(input.hostKeyFile).text, 'host key');
    const credential = parseRemoteConnectionCredential({
      schemaVersion: 1,
      kind: 'agent-deck-remote-connection-credential',
      label: input.label,
      topology: input.topology,
      instanceId: input.instanceId,
      credentialId: input.credentialId,
      endpoint: { hostname: input.hostname, port: input.port, username: input.username },
      hostKeys: [host],
      identity: { algorithm: 'ssh-ed25519', privateKey },
    });
    return Object.freeze({
      credential,
      clientPublicKey: `ssh-ed25519 ${generated.publicKey} agent-deck:${input.credentialId}`,
      clientFingerprint: fingerprint(generated.publicKey),
      encodedCredential: `${JSON.stringify(credential, null, 2)}\n`,
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function sameSnapshot(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.mode === right.mode && left.uid === right.uid;
}

export function readTrustedTextFile(path: string): TrustedTextFile {
  requireAbsolutePath(path, 'managed file');
  let descriptor: number | null = null;
  try {
    if (realpathSync(path) !== path) throw new Error('managed file is not canonical');
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > MAX_MANAGED_FILE_BYTES || (before.mode & 0o022) !== 0) {
      throw new Error('managed file trust check failed');
    }
    const bytes = Buffer.alloc(before.size);
    const actual = before.size === 0 ? 0 : readFileSync(descriptor).copy(bytes);
    const after = fstatSync(descriptor);
    if (actual !== before.size || !sameSnapshot(before, after) || realpathSync(path) !== path) {
      throw new Error('managed file changed while it was read');
    }
    try {
      return {
        path,
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        mode: before.mode & 0o777,
      };
    } finally {
      bytes.fill(0);
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function writeBytesExclusive(path: string, text: string, mode: number): void {
  const bytes = Buffer.from(text, 'utf8');
  let descriptor: number | null = null;
  let created = false;
  let failure: unknown = null;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      mode,
    );
    created = true;
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset);
    fsyncSync(descriptor);
  } catch (error) {
    failure = error;
  } finally {
    bytes.fill(0);
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure) {
    if (created) {
      try { unlinkSync(path); } catch {}
    }
    throw failure;
  }
}

function syncDirectory(path: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function replaceExpected(current: TrustedTextFile, next: string): void {
  const observed = readTrustedTextFile(current.path);
  if (observed.text !== current.text || observed.mode !== current.mode) {
    throw new Error('managed file changed before credential issuance');
  }
  const parent = dirname(current.path);
  const temporary = join(parent, `.${basename(current.path)}.${randomUUID()}.tmp`);
  try {
    writeBytesExclusive(temporary, next, current.mode);
    renameSync(temporary, current.path);
    syncDirectory(parent);
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
}

export function commitRemoteConnectionIssue(input: {
  readonly outputFile: string;
  readonly encodedCredential: string;
  readonly mutations: readonly CredentialIssueMutation[];
}): void {
  requireAbsolutePath(input.outputFile, 'output');
  if (statSync(input.outputFile, { throwIfNoEntry: false }) !== undefined) {
    throw new Error('connection credential output already exists');
  }
  const committed: CredentialIssueMutation[] = [];
  let outputCreated = false;
  try {
    for (const mutation of input.mutations) {
      try {
        replaceExpected(mutation.current, mutation.next);
        committed.push(mutation);
      } catch (error) {
        try {
          if (readTrustedTextFile(mutation.current.path).text === mutation.next) {
            committed.push(mutation);
          }
        } catch {}
        throw error;
      }
    }
    writeBytesExclusive(input.outputFile, input.encodedCredential, 0o600);
    outputCreated = true;
    syncDirectory(dirname(input.outputFile));
  } catch (error) {
    if (outputCreated) {
      try { unlinkSync(input.outputFile); } catch {}
    }
    for (const mutation of committed.reverse()) {
      try {
        replaceExpected(
          { ...mutation.current, text: mutation.next },
          mutation.current.text,
        );
      } catch {}
    }
    throw error;
  }
}
