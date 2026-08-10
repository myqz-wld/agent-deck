import {
  assertExactKeys,
  requireAbsolutePath,
  requireObject,
  requirePositiveInteger,
} from '@hosts/linux-runtime/validation';

import type { ProductionLinuxInstanceManagerOptions } from './adapters/production';
import type {
  CreateInstanceRequest,
  FullResourceSpec,
  InstanceSelector,
  ManagedTopology,
  UpgradeInstanceRequest,
  VersionFence,
} from './types';

const ROOT_KEYS = [
  'serviceHome', 'runtimeRoot', 'unitRoot', 'metadataRoot', 'backupRoot',
  'journalRoot', 'cutoverEvidenceRoot', 'fullTemplatePath', 'fullPreflightPath',
  'relayTemplatePath', 'relayPreflightPath', 'relayEvidenceRoot',
] as const;

const LIMIT_KEYS = [
  'commandTimeoutMs', 'lifecycleTimeoutMs', 'healthTimeoutMs',
  'maxOutputBytes', 'maxArtifactBytes', 'maxEvidenceAgeMs',
] as const;

const RESOURCE_KEYS = [
  'cpuCores', 'memoryBytes', 'pids', 'rootfsBytes', 'tmpfsBytes', 'logBytes',
] as const;

export type InstanceManagerCliCommand =
  | 'plan-list'
  | 'list'
  | 'plan-create'
  | 'create'
  | 'plan-start'
  | 'start'
  | 'plan-stop'
  | 'stop'
  | 'plan-status'
  | 'status'
  | 'describe'
  | 'plan-upgrade'
  | 'upgrade'
  | 'plan-rollback'
  | 'rollback';

export type InstanceManagerCliRequest =
  | CreateInstanceRequest
  | InstanceSelector
  | UpgradeInstanceRequest
  | VersionFence;

function requireUid(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0x7fffffff) {
    throw new Error(`${field} must be a bounded uid`);
  }
  return value as number;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireTopology(value: unknown): ManagedTopology {
  if (value !== 'full' && value !== 'relay') throw new Error('topology must be full or relay');
  return value;
}

function parseResources(value: unknown): FullResourceSpec {
  const object = requireObject(value, 'fullResources');
  assertExactKeys(object, RESOURCE_KEYS, 'fullResources');
  for (const key of RESOURCE_KEYS) {
    if (typeof object[key] !== 'number' || !Number.isFinite(object[key])) {
      throw new Error(`fullResources.${key} must be a finite number`);
    }
  }
  return object as unknown as FullResourceSpec;
}

function parseSelector(value: Record<string, unknown>): InstanceSelector {
  return {
    topology: requireTopology(value.topology),
    instanceId: requireString(value.instanceId, 'instanceId'),
  };
}

function exactKeysForTopology(
  value: Record<string, unknown>,
  common: readonly string[],
  topology: ManagedTopology,
  field: string,
): void {
  assertExactKeys(value, topology === 'full' ? [...common, 'fullResources'] : common, field);
}

export function parseInstanceManagerCliConfig(
  value: unknown,
): ProductionLinuxInstanceManagerOptions {
  const object = requireObject(value, 'instance manager config');
  assertExactKeys(object, [
    'schemaVersion', 'roots', 'limits', 'serviceUid', 'trustedRootUid',
    'trustedArtifactUid', 'lockRoot',
  ], 'instance manager config');
  if (object.schemaVersion !== 1) throw new Error('unsupported instance manager config schema');

  const roots = requireObject(object.roots, 'roots');
  assertExactKeys(roots, ROOT_KEYS, 'roots');
  const limits = requireObject(object.limits, 'limits');
  assertExactKeys(limits, LIMIT_KEYS, 'limits');

  return {
    roots: Object.fromEntries(ROOT_KEYS.map((key) => [
      key,
      requireAbsolutePath(roots[key], `roots.${key}`),
    ])) as unknown as ProductionLinuxInstanceManagerOptions['roots'],
    limits: Object.fromEntries(LIMIT_KEYS.map((key) => [
      key,
      requirePositiveInteger(limits[key], `limits.${key}`),
    ])) as unknown as ProductionLinuxInstanceManagerOptions['limits'],
    serviceUid: requireUid(object.serviceUid, 'serviceUid'),
    trustedRootUid: requireUid(object.trustedRootUid, 'trustedRootUid'),
    trustedArtifactUid: requireUid(object.trustedArtifactUid, 'trustedArtifactUid'),
    lockRoot: requireAbsolutePath(object.lockRoot, 'lockRoot'),
  };
}

export function parseInstanceManagerCliRequest(
  command: InstanceManagerCliCommand,
  value: unknown,
): InstanceManagerCliRequest {
  const object = requireObject(value, 'instance manager request');
  if (['plan-start', 'start', 'plan-stop', 'stop', 'plan-status', 'status', 'describe'].includes(command)) {
    assertExactKeys(object, ['topology', 'instanceId'], 'instance manager request');
    return parseSelector(object);
  }
  if (command === 'plan-create' || command === 'create') {
    const topology = requireTopology(object.topology);
    exactKeysForTopology(
      object,
      ['topology', 'instanceId', 'version', 'image', 'runtimeConfig'],
      topology,
      'instance manager request',
    );
    return {
      ...parseSelector(object),
      version: requireString(object.version, 'version'),
      image: requireString(object.image, 'image'),
      runtimeConfig: object.runtimeConfig,
      ...(topology === 'full' ? { fullResources: parseResources(object.fullResources) } : {}),
    };
  }
  if (command === 'plan-upgrade' || command === 'upgrade') {
    const topology = requireTopology(object.topology);
    exactKeysForTopology(
      object,
      [
        'topology', 'instanceId', 'expectedGeneration', 'expectedVersion',
        'nextVersion', 'nextImage', 'runtimeConfig',
      ],
      topology,
      'instance manager request',
    );
    return {
      ...parseSelector(object),
      expectedGeneration: requirePositiveInteger(object.expectedGeneration, 'expectedGeneration'),
      expectedVersion: requireString(object.expectedVersion, 'expectedVersion'),
      nextVersion: requireString(object.nextVersion, 'nextVersion'),
      nextImage: requireString(object.nextImage, 'nextImage'),
      runtimeConfig: object.runtimeConfig,
      ...(topology === 'full' ? { fullResources: parseResources(object.fullResources) } : {}),
    };
  }
  if (command === 'plan-rollback' || command === 'rollback') {
    assertExactKeys(
      object,
      ['topology', 'instanceId', 'expectedGeneration', 'expectedVersion'],
      'instance manager request',
    );
    return {
      ...parseSelector(object),
      expectedGeneration: requirePositiveInteger(object.expectedGeneration, 'expectedGeneration'),
      expectedVersion: requireString(object.expectedVersion, 'expectedVersion'),
    };
  }
  throw new Error(`${command} does not accept a request file`);
}
