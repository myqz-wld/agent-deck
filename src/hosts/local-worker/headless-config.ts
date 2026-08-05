import { isJsonObject, type JsonObject } from '@contracts/index';
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
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly appVersion: string;
  readonly runtimeModule: string;
  readonly runtimeOptions: JsonObject;
  readonly generationFile: string;
  readonly ssh: LocalWorkerSshConfig;
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
  ], 'local-worker config');
  if (object.schemaVersion !== 1) throw new Error('local-worker schemaVersion must be 1');
  if (!isJsonObject(object.runtimeOptions)) throw new Error('runtimeOptions must be JSON');
  const instanceId = requireLinuxInstanceId(object.instanceId);
  const ssh = parseSsh(object.ssh);
  if (ssh.instanceId !== instanceId) {
    throw new Error('local-worker and SSH instance ids must match');
  }
  return Object.freeze({
    schemaVersion: 1,
    instanceId,
    appVersion: boundedText(object.appVersion, 'appVersion'),
    runtimeModule: requireAbsolutePath(object.runtimeModule, 'runtimeModule'),
    runtimeOptions: object.runtimeOptions,
    generationFile: requireAbsolutePath(object.generationFile, 'generationFile'),
    ssh,
  });
}
