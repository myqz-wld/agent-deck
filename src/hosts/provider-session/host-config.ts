import { dirname, isAbsolute, relative, sep } from 'node:path';

import {
  assertExactKeys,
  requireAbsolutePath,
  requireLinuxInstanceId,
  requireObject,
  requirePositiveInteger,
} from '@hosts/linux-runtime/validation';

import {
  PROVIDER_SESSION_MAX_ACTIVE_CONTAINERS,
  isPinnedProviderSessionImage,
  type ProviderSessionImageCatalog,
  type ProviderSessionOciEngine,
} from './types';

export interface ProviderSessionSupervisorHostConfig {
  readonly schemaVersion: 1;
  readonly brokerRoot: string;
  readonly desktopSocketPath: string | null;
  readonly desktopVm: 'colima' | 'docker-desktop' | null;
  readonly engine: ProviderSessionOciEngine;
  readonly executable: string;
  readonly images: ProviderSessionImageCatalog;
  readonly instanceId: string;
  readonly maxActive: number;
  readonly privateRoot: string;
  readonly rootlessHome: string | null;
  readonly rootlessRuntimeDirectory: string | null;
  readonly stateRoot: string;
  readonly transportRuntimeDirectory: string;
  readonly transportSocketPath: string;
  readonly workspaceRoot: string;
}

const CONFIG_KEYS = Object.freeze([
  'brokerRoot',
  'desktopSocketPath',
  'desktopVm',
  'engine',
  'executable',
  'images',
  'instanceId',
  'maxActive',
  'privateRoot',
  'rootlessHome',
  'rootlessRuntimeDirectory',
  'schemaVersion',
  'stateRoot',
  'transportRuntimeDirectory',
  'transportSocketPath',
  'workspaceRoot',
] as const);
const IMAGE_KEYS = Object.freeze([
  'claude-code-v1',
  'codex-cli-v1',
  'grok-build-v1',
] as const);
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MAX_PATH_BYTES = 4_096;
const MAX_SOCKET_BYTES = 103;

function path(value: unknown, field: string): string {
  const parsed = requireAbsolutePath(value, field);
  if (Buffer.byteLength(parsed) > MAX_PATH_BYTES || CONTROL.test(parsed)) {
    throw new Error(`${field} is invalid`);
  }
  return parsed;
}

function nullablePath(value: unknown, field: string): string | null {
  return value === null ? null : path(value, field);
}

function within(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === '' || (
    relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
  );
}

function requireChild(parent: string, child: string, field: string): void {
  if (parent === child || !within(parent, child)) {
    throw new Error(`${field} must be inside the Provider private root`);
  }
}

function disjoint(left: string, right: string, field: string): void {
  if (within(left, right) || within(right, left)) {
    throw new Error(`${field} must be disjoint`);
  }
}

function images(value: unknown): ProviderSessionImageCatalog {
  const object = requireObject(value, 'provider supervisor images');
  assertExactKeys(object, IMAGE_KEYS, 'provider supervisor images');
  const parsed = Object.fromEntries(IMAGE_KEYS.map((key) => {
    const candidate = object[key];
    if (candidate !== null && !isPinnedProviderSessionImage(
      typeof candidate === 'string' ? candidate : null,
    )) {
      throw new Error(`provider supervisor images.${key} is invalid`);
    }
    return [key, candidate];
  })) as Record<(typeof IMAGE_KEYS)[number], string | null>;
  return Object.freeze(parsed);
}

function engine(value: unknown): ProviderSessionOciEngine {
  if (value !== 'rootless-podman' && value !== 'docker-desktop') {
    throw new Error('provider supervisor engine is invalid');
  }
  return value;
}

function desktopVm(value: unknown): 'colima' | 'docker-desktop' | null {
  if (value !== null && value !== 'colima' && value !== 'docker-desktop') {
    throw new Error('provider supervisor desktopVm is invalid');
  }
  return value;
}

/** Exact host-private configuration. No field from this document crosses the Core RPC boundary. */
export function parseProviderSessionSupervisorHostConfig(
  value: unknown,
): ProviderSessionSupervisorHostConfig {
  const object = requireObject(value, 'provider supervisor config');
  assertExactKeys(object, CONFIG_KEYS, 'provider supervisor config');
  if (object.schemaVersion !== 1) {
    throw new Error('provider supervisor schemaVersion must be 1');
  }
  const parsedEngine = engine(object.engine);
  const parsedDesktopVm = desktopVm(object.desktopVm);
  const parsedDesktopSocket = nullablePath(
    object.desktopSocketPath,
    'provider supervisor desktopSocketPath',
  );
  const parsedRootlessHome = nullablePath(
    object.rootlessHome,
    'provider supervisor rootlessHome',
  );
  const parsedRootlessRuntime = nullablePath(
    object.rootlessRuntimeDirectory,
    'provider supervisor rootlessRuntimeDirectory',
  );
  if (parsedEngine === 'rootless-podman') {
    if (!parsedRootlessHome || !parsedRootlessRuntime || parsedDesktopSocket || parsedDesktopVm) {
      throw new Error('rootless Podman host configuration is invalid');
    }
  } else if (!parsedDesktopSocket || !parsedDesktopVm ||
      parsedRootlessHome || parsedRootlessRuntime) {
    throw new Error('desktop OCI host configuration is invalid');
  }

  const workspaceRoot = path(object.workspaceRoot, 'provider supervisor workspaceRoot');
  const privateRoot = path(object.privateRoot, 'provider supervisor privateRoot');
  const stateRoot = path(object.stateRoot, 'provider supervisor stateRoot');
  const brokerRoot = path(object.brokerRoot, 'provider supervisor brokerRoot');
  const transportRuntimeDirectory = path(
    object.transportRuntimeDirectory,
    'provider supervisor transportRuntimeDirectory',
  );
  const transportSocketPath = path(
    object.transportSocketPath,
    'provider supervisor transportSocketPath',
  );
  const executable = path(object.executable, 'provider supervisor executable');
  disjoint(workspaceRoot, privateRoot, 'Provider Workspace and private roots');
  requireChild(privateRoot, stateRoot, 'provider supervisor stateRoot');
  requireChild(privateRoot, brokerRoot, 'provider supervisor brokerRoot');
  requireChild(
    privateRoot,
    transportRuntimeDirectory,
    'provider supervisor transportRuntimeDirectory',
  );
  disjoint(stateRoot, brokerRoot, 'Provider state and broker roots');
  disjoint(stateRoot, transportRuntimeDirectory, 'Provider state and transport roots');
  disjoint(brokerRoot, transportRuntimeDirectory, 'Provider broker and transport roots');
  if (dirname(transportSocketPath) !== transportRuntimeDirectory ||
      (Buffer.byteLength(transportSocketPath) > MAX_SOCKET_BYTES &&
        Buffer.byteLength(relative(privateRoot, transportSocketPath)) > MAX_SOCKET_BYTES)) {
    throw new Error('provider supervisor transportSocketPath is invalid');
  }
  if (within(workspaceRoot, executable) ||
      (parsedDesktopSocket && within(workspaceRoot, parsedDesktopSocket))) {
    throw new Error('provider supervisor engine authority overlaps the Workspace');
  }

  return Object.freeze({
    schemaVersion: 1,
    brokerRoot,
    desktopSocketPath: parsedDesktopSocket,
    desktopVm: parsedDesktopVm,
    engine: parsedEngine,
    executable,
    images: images(object.images),
    instanceId: requireLinuxInstanceId(object.instanceId),
    maxActive: requirePositiveInteger(
      object.maxActive,
      'provider supervisor maxActive',
      PROVIDER_SESSION_MAX_ACTIVE_CONTAINERS,
    ),
    privateRoot,
    rootlessHome: parsedRootlessHome,
    rootlessRuntimeDirectory: parsedRootlessRuntime,
    stateRoot,
    transportRuntimeDirectory,
    transportSocketPath,
    workspaceRoot,
  });
}
