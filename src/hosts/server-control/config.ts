import type { RemoteHostRemoteTopology } from '@shared/remote-host';

import {
  assertExactKeys,
  requireAbsolutePath,
  requireLinuxInstanceId,
  requireObject,
  requirePositiveInteger,
} from '@hosts/linux-runtime/validation';

export interface ServerControlConfig {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly topology: RemoteHostRemoteTopology;
  readonly authorityFile: string;
  readonly authorizedKeysFile: string;
  readonly endpoint: {
    readonly hostname: string;
    readonly port: number;
    readonly username: string;
    readonly hostKeyFile: string;
  };
  readonly relayRuntimeUid: number | null;
  readonly feishuIdentityOwner: {
    readonly uid: number;
    readonly gid: number;
  };
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== 'string' || value.length === 0 || value.length > maximum ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  ) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value as number;
}

export function parseServerControlConfig(value: unknown): ServerControlConfig {
  const object = requireObject(value, 'server control config');
  assertExactKeys(object, [
    'authorityFile',
    'authorizedKeysFile',
    'endpoint',
    'feishuIdentityOwner',
    'instanceId',
    'relayRuntimeUid',
    'schemaVersion',
    'topology',
  ], 'server control config');
  if (object.schemaVersion !== 1) {
    throw new Error('server control schemaVersion is unsupported');
  }
  if (object.topology !== 'relay' && object.topology !== 'full') {
    throw new Error('server control topology is invalid');
  }
  const endpoint = requireObject(object.endpoint, 'server control endpoint');
  assertExactKeys(endpoint, [
    'hostKeyFile', 'hostname', 'port', 'username',
  ], 'server control endpoint');
  const hostname = boundedText(endpoint.hostname, 'server control hostname', 253);
  const username = boundedText(endpoint.username, 'server control username', 128);
  if (!/^[A-Za-z0-9._:-]+$/u.test(hostname) || hostname.startsWith('-')) {
    throw new Error('server control hostname is invalid');
  }
  if (!/^[A-Za-z0-9._-]+$/u.test(username) || username.startsWith('-')) {
    throw new Error('server control username is invalid');
  }
  const owner = requireObject(object.feishuIdentityOwner, 'Feishu identity owner');
  assertExactKeys(owner, ['gid', 'uid'], 'Feishu identity owner');
  const relayRuntimeUid = object.relayRuntimeUid === null
    ? null
    : requirePositiveInteger(object.relayRuntimeUid, 'relayRuntimeUid');
  if (
    (object.topology === 'relay' && relayRuntimeUid === null) ||
    (object.topology === 'full' && relayRuntimeUid !== null)
  ) {
    throw new Error('relayRuntimeUid does not match topology');
  }
  return Object.freeze({
    schemaVersion: 1,
    instanceId: requireLinuxInstanceId(object.instanceId),
    topology: object.topology,
    authorityFile: requireAbsolutePath(object.authorityFile, 'authorityFile'),
    authorizedKeysFile: requireAbsolutePath(
      object.authorizedKeysFile,
      'authorizedKeysFile',
    ),
    endpoint: Object.freeze({
      hostname,
      port: requirePositiveInteger(endpoint.port, 'server control port', 65_535),
      username,
      hostKeyFile: requireAbsolutePath(endpoint.hostKeyFile, 'hostKeyFile'),
    }),
    relayRuntimeUid,
    feishuIdentityOwner: Object.freeze({
      uid: nonNegativeInteger(owner.uid, 'Feishu identity uid'),
      gid: nonNegativeInteger(owner.gid, 'Feishu identity gid'),
    }),
  });
}
