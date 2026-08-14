import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
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
  REMOTE_CONNECTION_CREDENTIAL_SCHEMA_VERSION,
  type RemoteConnectionCredential,
  type RemoteHostRemoteTopology,
} from '@shared/remote-host';

import { requireAbsolutePath, requirePositiveInteger } from './validation';
import { deriveConnectionScope } from './connection-scope';

const MAX_MANAGED_FILE_BYTES = 1024 * 1024;
const SSH_KEYGEN = '/usr/bin/ssh-keygen';

export interface RemoteConnectionIssueInput {
  readonly purpose: 'client' | 'worker';
  readonly topology: RemoteHostRemoteTopology;
  readonly instanceId: string;
  readonly credentialId: string;
  readonly label: string;
  readonly hostname: string;
  readonly port: number;
  readonly username: string;
  readonly hostKeyFile: string;
  readonly outputFile: string;
  readonly workerId?: string;
}

export interface PreparedRemoteConnectionIssue {
  readonly credential: RemoteConnectionCredential;
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly encodedCredential: string;
}

export interface TrustedTextFile {
  readonly path: string;
  readonly text: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

export interface CredentialIssueMutation {
  readonly current: TrustedTextFile;
  readonly next: string;
}

export interface PrivateTextOutput {
  readonly path: string;
  readonly text: string;
  readonly mode: number;
  readonly uid?: number;
  readonly gid?: number;
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

function generateIdentity(
  identityPath: string,
  comment: string,
): {
  readonly identity: { readonly algorithm: 'ssh-ed25519'; readonly privateKey: string };
  readonly publicKey: string;
  readonly fingerprint: string;
} {
  execFileSync(SSH_KEYGEN, [
    '-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', identityPath,
  ], {
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const identityStat = lstatSync(identityPath);
  if (!identityStat.isFile() || identityStat.isSymbolicLink() ||
      (identityStat.mode & 0o777) !== 0o600) {
    throw new Error('generated SSH identity failed its trust check');
  }
  const generated = keyParts(readFileSync(`${identityPath}.pub`, 'utf8'), 'generated key');
  if (generated.algorithm !== 'ssh-ed25519') throw new Error('generated key is not Ed25519');
  return {
    identity: { algorithm: 'ssh-ed25519', privateKey: readSecretText(identityPath) },
    publicKey: `ssh-ed25519 ${generated.publicKey} ${comment}`,
    fingerprint: fingerprint(generated.publicKey),
  };
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
  if (
    (input.purpose === 'worker' && (input.topology !== 'relay' || !input.workerId)) ||
    (input.purpose === 'client' && input.workerId !== undefined)
  ) {
    throw new Error('connection issuance purpose and Worker identity are inconsistent');
  }
  const tempRoot = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'agent-deck-issue-')));
  const identityPath = join(tempRoot, 'identity');
  try {
    const identity = generateIdentity(
      identityPath,
      input.purpose === 'worker'
        ? `agent-deck-worker:${input.credentialId}`
        : `agent-deck:${input.credentialId}`,
    );
    const host = keyParts(readTrustedTextFile(input.hostKeyFile).text, 'host key');
    const credential = parseRemoteConnectionCredential({
      schemaVersion: REMOTE_CONNECTION_CREDENTIAL_SCHEMA_VERSION,
      kind: 'agent-deck-remote-connection-credential',
      label: input.label,
      purpose: input.purpose,
      topology: input.topology,
      instanceId: input.instanceId,
      credentialId: input.credentialId,
      ...(input.purpose === 'client'
        ? { connectionScope: deriveConnectionScope(input.instanceId, input.credentialId) }
        : {}),
      endpoint: { hostname: input.hostname, port: input.port, username: input.username },
      hostKeys: [host],
      identity: identity.identity,
      ...(input.purpose === 'worker' ? { workerId: input.workerId } : {}),
    });
    return Object.freeze({
      credential,
      publicKey: identity.publicKey,
      fingerprint: identity.fingerprint,
      encodedCredential: `${JSON.stringify(credential, null, 2)}\n`,
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function sameSnapshot(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.mode === right.mode && left.uid === right.uid &&
    left.gid === right.gid;
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
        uid: before.uid,
        gid: before.gid,
      };
    } finally {
      bytes.fill(0);
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function writeBytesExclusive(
  path: string,
  text: string,
  mode: number,
  owner?: { readonly uid: number; readonly gid: number },
): void {
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
    fchmodSync(descriptor, mode);
    if (owner) fchownSync(descriptor, owner.uid, owner.gid);
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
  if (
    observed.text !== current.text || observed.mode !== current.mode ||
    observed.uid !== current.uid || observed.gid !== current.gid
  ) {
    throw new Error('managed file changed before credential issuance');
  }
  const parent = dirname(current.path);
  const temporary = join(parent, `.${basename(current.path)}.${randomUUID()}.tmp`);
  try {
    writeBytesExclusive(temporary, next, current.mode, {
      uid: current.uid,
      gid: current.gid,
    });
    renameSync(temporary, current.path);
    syncDirectory(parent);
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
}

export function commitManagedTextTransaction(input: {
  readonly mutations: readonly CredentialIssueMutation[];
  readonly output?: PrivateTextOutput;
}): void {
  if (input.mutations.length === 0) throw new Error('managed transaction requires a mutation');
  const paths = input.mutations.map((mutation) => mutation.current.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error('managed transaction contains duplicate targets');
  }
  if (input.output) {
    requireAbsolutePath(input.output.path, 'output');
    const outputParent = dirname(input.output.path);
    if (
      realpathSync(outputParent) !== outputParent ||
      statSync(input.output.path, { throwIfNoEntry: false }) !== undefined
    ) {
      throw new Error('connection credential output path is not a new canonical file');
    }
    if (
      input.output.mode !== 0o600 ||
      (input.output.uid === undefined) !== (input.output.gid === undefined) ||
      (input.output.uid !== undefined && (
        !Number.isSafeInteger(input.output.uid) || input.output.uid < 0 ||
        !Number.isSafeInteger(input.output.gid) || (input.output.gid as number) < 0
      ))
    ) {
      throw new Error('private output owner or mode is invalid');
    }
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
    if (input.output) {
      writeBytesExclusive(
        input.output.path,
        input.output.text,
        input.output.mode,
        input.output.uid === undefined
          ? undefined
          : { uid: input.output.uid, gid: input.output.gid as number },
      );
      outputCreated = true;
      syncDirectory(dirname(input.output.path));
    }
  } catch (error) {
    let rollbackFailure: unknown = null;
    if (outputCreated && input.output) {
      try {
        unlinkSync(input.output.path);
        syncDirectory(dirname(input.output.path));
      } catch (rollbackError) {
        rollbackFailure ??= rollbackError;
      }
    }
    for (const mutation of committed.reverse()) {
      try {
        replaceExpected(
          { ...mutation.current, text: mutation.next },
          mutation.current.text,
        );
      } catch (rollbackError) {
        rollbackFailure ??= rollbackError;
      }
    }
    if (rollbackFailure) {
      throw new Error('managed transaction failed and rollback was incomplete', {
        cause: rollbackFailure,
      });
    }
    throw error;
  }
}

export function commitRemoteConnectionIssue(input: {
  readonly outputFile: string;
  readonly encodedCredential: string;
  readonly mutations: readonly CredentialIssueMutation[];
}): void {
  commitManagedTextTransaction({
    mutations: input.mutations,
    output: {
      path: input.outputFile,
      text: input.encodedCredential,
      mode: 0o600,
    },
  });
}
