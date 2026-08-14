import {
  assertExactKeys,
  requireAbsolutePath,
  requireLinuxInstanceId,
  requireObject,
  requirePositiveInteger,
} from '@hosts/linux-runtime/validation';

export interface RelayHeadlessConfig {
  readonly schemaVersion: 2;
  readonly instanceId: string;
  readonly tickIntervalMs: number;
  readonly plumbingModule: string | null;
  readonly authorityFile: string;
}

export function parseRelayHeadlessConfig(value: unknown): RelayHeadlessConfig {
  const object = requireObject(value, 'relay config');
  assertExactKeys(object, [
    'authorityFile',
    'instanceId',
    'plumbingModule',
    'schemaVersion',
    'tickIntervalMs',
  ], 'relay config');
  if (object.schemaVersion !== 2) throw new Error('relay schemaVersion must be 2');
  const instanceId = requireLinuxInstanceId(object.instanceId);
  const authorityFile = requireAbsolutePath(object.authorityFile, 'authorityFile');
  if (authorityFile !== `/etc/agent-deck-relay/${instanceId}/authority.json`) {
    throw new Error('relay authorityFile must use the exact per-instance container path');
  }
  return Object.freeze({
    schemaVersion: 2,
    instanceId,
    tickIntervalMs: requirePositiveInteger(object.tickIntervalMs, 'tickIntervalMs', 60_000),
    plumbingModule:
      object.plumbingModule === null
        ? null
        : requireAbsolutePath(object.plumbingModule, 'plumbingModule'),
    authorityFile,
  });
}
