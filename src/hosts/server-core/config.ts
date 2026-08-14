import { basename, dirname } from 'node:path';

import { isJsonObject, type JsonObject } from '@contracts/index';
import {
  assertExactKeys,
  requireAbsolutePath,
  requireLinuxInstanceId,
  requireObject,
} from '@hosts/linux-runtime/validation';

export interface ServerCoreConfig {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly appVersion: string;
  readonly runtimeModule: string;
  readonly runtimeOptions: JsonObject;
  readonly socketPath: string;
}

function boundedText(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 128 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new Error(`${field} must be bounded text`);
  }
  return value;
}

export function parseServerCoreConfig(value: unknown): ServerCoreConfig {
  const object = requireObject(value, 'server-core config');
  assertExactKeys(
    object,
    ['appVersion', 'instanceId', 'runtimeModule', 'runtimeOptions', 'schemaVersion', 'socketPath'],
    'server-core config',
  );
  if (object.schemaVersion !== 1) throw new Error('server-core schemaVersion must be 1');
  const instanceId = requireLinuxInstanceId(object.instanceId);
  if (!isJsonObject(object.runtimeOptions)) throw new Error('runtimeOptions must be JSON');
  const socketPath = requireAbsolutePath(object.socketPath, 'socketPath');
  if (basename(socketPath) !== 'agent-deckd.sock' || basename(dirname(socketPath)) !== instanceId) {
    throw new Error('socketPath must use the exact instance namespace');
  }
  return Object.freeze({
    schemaVersion: 1,
    instanceId,
    appVersion: boundedText(object.appVersion, 'appVersion'),
    runtimeModule: requireAbsolutePath(object.runtimeModule, 'runtimeModule'),
    runtimeOptions: object.runtimeOptions,
    socketPath,
  });
}
