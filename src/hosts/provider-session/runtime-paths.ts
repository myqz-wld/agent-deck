import { createHash } from 'node:crypto';
import { isAbsolute, join, normalize, relative } from 'node:path';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const MAX_UNIX_SOCKET_PATH_BYTES = 103;

export interface ProviderSessionRuntimePathInput {
  readonly instanceId: string;
  readonly platform: NodeJS.Platform;
  readonly runtimeParent: string;
  readonly uid: number;
  readonly workerConfigId?: string;
}

export interface ProviderSessionRuntimePaths {
  readonly brokerRoot: string;
  readonly privateRoot: string;
  readonly stateRoot: string;
  readonly supervisorRoot: string;
  readonly supervisorSocketPath: string;
}

export interface ProviderSessionWorkerRuntimeRootInput {
  readonly platform: NodeJS.Platform;
  readonly uid: number;
  readonly workerConfigId: string;
}

function token(value: string, field: string): string {
  if (!TOKEN.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function directory(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value || value === '/') {
    throw new Error('provider runtime parent is invalid');
  }
  return value;
}

/**
 * Derives the same private namespace in Core and the host provisioning tool. macOS Relay Workers
 * use a uid-scoped canonical /private/tmp root because their app-container state path exceeds the
 * portable Unix-socket limit. No engine authority or credential is stored in this namespace.
 */
export function providerSessionRuntimePaths(
  input: ProviderSessionRuntimePathInput,
): ProviderSessionRuntimePaths {
  const instanceId = token(input.instanceId, 'provider runtime instanceId');
  const workerConfigId = input.workerConfigId === undefined
    ? null
    : token(input.workerConfigId, 'provider runtime workerConfigId');
  if (!Number.isSafeInteger(input.uid) || input.uid <= 0) {
    throw new Error('provider runtime uid is invalid');
  }
  const digest = createHash('sha256').update(instanceId).digest('hex').slice(0, 16);
  const privateRoot = workerConfigId === null
    ? join(directory(input.runtimeParent), `.provider-${digest}`)
    : providerSessionWorkerRuntimeRoot({
      platform: input.platform,
      uid: input.uid,
      workerConfigId,
    });
  const brokerRoot = join(privateRoot, 'broker');
  const stateRoot = join(privateRoot, 'state');
  const supervisorRoot = join(privateRoot, 'supervisor');
  const supervisorSocketPath = join(supervisorRoot, 's.sock');
  const brokerSocketPath = join(brokerRoot, `b-${'a'.repeat(20)}.sock`);
  if (
    (Buffer.byteLength(supervisorSocketPath) > MAX_UNIX_SOCKET_PATH_BYTES &&
      Buffer.byteLength(relative(privateRoot, supervisorSocketPath)) >
        MAX_UNIX_SOCKET_PATH_BYTES) ||
    (Buffer.byteLength(brokerSocketPath) > MAX_UNIX_SOCKET_PATH_BYTES &&
      Buffer.byteLength(relative(privateRoot, brokerSocketPath)) >
        MAX_UNIX_SOCKET_PATH_BYTES)
  ) {
    throw new Error('provider runtime socket namespace exceeds its portable bound');
  }
  return Object.freeze({
    brokerRoot,
    privateRoot,
    stateRoot,
    supervisorRoot,
    supervisorSocketPath,
  });
}

/** Host-visible, sandbox-mounted short root for one Relay Worker identity. */
export function providerSessionWorkerRuntimeRoot(
  input: ProviderSessionWorkerRuntimeRootInput,
): string {
  const workerConfigId = token(input.workerConfigId, 'provider runtime workerConfigId');
  if (!Number.isSafeInteger(input.uid) || input.uid <= 0) {
    throw new Error('provider runtime uid is invalid');
  }
  const digest = createHash('sha256').update(workerConfigId).digest('hex').slice(0, 16);
  if (input.platform === 'darwin') {
    return join('/private/tmp', `adp-${input.uid}-${digest}`);
  }
  if (input.platform === 'linux') {
    return join('/run/user', String(input.uid), `adp-${digest}`);
  }
  throw new Error('provider runtime platform is unsupported');
}
