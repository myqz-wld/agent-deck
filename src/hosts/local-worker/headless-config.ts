import {
  isJsonObject,
  parseWorkspaceSandboxSpec,
  type JsonObject,
  type WorkspaceSandboxSpec,
} from '@contracts/index';
import {
  assertExactKeys,
  requireAbsolutePath,
  requireLinuxInstanceId,
  requireObject,
  requirePositiveInteger,
  requireStableToken,
} from '@hosts/linux-runtime/validation';

import {
  assertLocalWorkerSshConfig,
  type LocalWorkerSshConfig,
} from './config';

export interface LocalWorkerHeadlessConfig {
  readonly schemaVersion: 2;
  readonly instanceId: string;
  readonly appVersion: string;
  readonly runtimeModule: string;
  readonly runtimeOptions: JsonObject;
  readonly generationFile: string;
  readonly ssh: LocalWorkerSshConfig;
  readonly workspaceSandbox: WorkspaceSandboxSpec;
}

function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function boundedText(value: unknown, field: string): string {
  if (
    typeof value !== 'string' || value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 128 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) throw new Error(`${field} must be bounded text`);
  return value;
}

function parseSsh(value: unknown): LocalWorkerSshConfig {
  const object = requireObject(value, 'ssh');
  assertExactKeys(object, [
    'connectTimeoutSeconds',
    'credentialId',
    'host',
    'identityFile',
    'instanceId',
    'knownHostsFile',
    'port',
    'sshBinary',
    'user',
    'workerId',
  ], 'ssh');
  const parsed: LocalWorkerSshConfig = {
    sshBinary: requireAbsolutePath(object.sshBinary, 'ssh.sshBinary'),
    host: requireStableToken(object.host, 'ssh.host'),
    port: requirePositiveInteger(object.port, 'ssh.port', 65_535),
    user: requireStableToken(object.user, 'ssh.user'),
    identityFile: requireAbsolutePath(object.identityFile, 'ssh.identityFile'),
    knownHostsFile: requireAbsolutePath(object.knownHostsFile, 'ssh.knownHostsFile'),
    instanceId: requireLinuxInstanceId(object.instanceId, 'ssh.instanceId'),
    workerId: requireStableToken(object.workerId, 'ssh.workerId'),
    credentialId: requireStableToken(object.credentialId, 'ssh.credentialId'),
    connectTimeoutSeconds: requirePositiveInteger(
      object.connectTimeoutSeconds,
      'ssh.connectTimeoutSeconds',
      600,
    ),
  };
  assertLocalWorkerSshConfig(parsed);
  return parsed;
}

export function parseLocalWorkerHeadlessConfig(value: unknown): LocalWorkerHeadlessConfig {
  const object = requireObject(value, 'local-worker config');
  assertExactKeys(object, [
    'appVersion',
    'generationFile',
    'instanceId',
    'runtimeModule',
    'runtimeOptions',
    'schemaVersion',
    'ssh',
    'workspaceSandbox',
  ], 'local-worker config');
  if (object.schemaVersion !== 2) {
    throw new Error('local-worker schemaVersion must be 2');
  }
  if (!isJsonObject(object.runtimeOptions)) throw new Error('runtimeOptions must be JSON');
  const instanceId = requireLinuxInstanceId(object.instanceId);
  const ssh = parseSsh(object.ssh);
  if (ssh.instanceId !== instanceId) {
    throw new Error('local-worker and SSH instance ids must match');
  }
  const generationFile = requireAbsolutePath(object.generationFile, 'generationFile');
  const runtimeModule = requireAbsolutePath(object.runtimeModule, 'runtimeModule');
  const workspaceSandbox = parseWorkspaceSandboxSpec(object.workspaceSandbox);
  if (workspaceSandbox.execution !== 'relay-worker' ||
      workspaceSandbox.workerId !== ssh.workerId) {
    throw new Error('local-worker and workspace sandbox identities must match');
  }
  for (const [field, path] of [
    ['generationFile', generationFile],
    ['ssh.identityFile', ssh.identityFile],
    ['ssh.knownHostsFile', ssh.knownHostsFile],
  ] as const) {
    if (!within(workspaceSandbox.privateRoot, path)) {
      throw new Error(`${field} must stay inside the Worker private root`);
    }
  }
  if (!workspaceSandbox.runtimeReadRoots.some((root) => within(root, runtimeModule))) {
    throw new Error('runtimeModule must stay inside an authorized runtime root');
  }
  return Object.freeze({
    schemaVersion: 2,
    instanceId,
    appVersion: boundedText(object.appVersion, 'appVersion'),
    runtimeModule,
    runtimeOptions: object.runtimeOptions,
    generationFile,
    ssh,
    workspaceSandbox,
  });
}
