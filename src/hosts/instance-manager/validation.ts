import { posix } from 'node:path';

import { assertInstanceId } from '@hosts/daemon/instance-paths';

import type { FileIdentity, FullResourceSpec, ManagedTopology } from './types';

const OCI_COMPONENT = '[a-z0-9]+(?:[._-][a-z0-9]+)*';
const OCI_REGISTRY = '[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?';
const DIGEST_PATTERN = new RegExp(
  `^(?:${OCI_REGISTRY}/)?${OCI_COMPONENT}(?:/${OCI_COMPONENT})*@sha256:([a-f0-9]{64})$`,
);
const VERSION_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OPERATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const NUL = '\u0000';

export class InstanceManagerError extends Error {
  constructor(
    readonly code:
      | 'already_exists'
      | 'command_failed'
      | 'conflict'
      | 'health_failed'
      | 'invalid_input'
      | 'not_found'
      | 'not_stopped'
      | 'tampered'
      | 'lock_failed'
      | 'recovery_required'
      | 'cleanup_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'InstanceManagerError';
  }
}

export function fail(code: InstanceManagerError['code'], message: string): never {
  throw new InstanceManagerError(code, message);
}

export function validateTopology(value: unknown): asserts value is ManagedTopology {
  if (value !== 'full' && value !== 'relay') fail('invalid_input', 'topology must be full or relay');
}

export function validateInstanceId(value: string): void {
  if (value.includes(NUL)) fail('invalid_input', 'instanceId contains NUL');
  try {
    assertInstanceId(value);
  } catch {
    fail('invalid_input', 'instanceId must be one unambiguous lowercase ASCII label');
  }
}

export function validateVersion(value: string, field = 'version'): void {
  if (!VERSION_PATTERN.test(value)) {
    fail('invalid_input', `${field} must be one unambiguous lowercase ASCII label`);
  }
}

export function validateImage(value: string): string {
  if (value.includes(NUL) || Buffer.byteLength(value, 'utf8') > 512 || !/^[\x21-\x7e]+$/.test(value)) {
    fail('invalid_input', 'image is unsafe or too long');
  }
  const match = DIGEST_PATTERN.exec(value);
  if (!match) fail('invalid_input', 'image must be pinned by one lowercase sha256 digest');
  return match[1];
}

export function validateOperationId(value: string): void {
  if (!OPERATION_ID_PATTERN.test(value)) fail('tampered', 'operation id is unsafe');
}

export function validateAbsoluteRoot(value: string, field: string): void {
  if (
    !value ||
    value.includes(NUL) ||
    !posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === '/' ||
    Buffer.byteLength(value, 'utf8') > 4_096
  ) {
    fail('invalid_input', `${field} must be a normalized non-root absolute Linux path`);
  }
}

export function isInside(path: string, root: string): boolean {
  const relative = posix.relative(root, path);
  return relative === '' || (!relative.startsWith('../') && relative !== '..' && !posix.isAbsolute(relative));
}

export function validateChildPath(path: string, root: string, field: string): void {
  validateAbsoluteRoot(path, field);
  if (!isInside(path, root) || path === root) fail('tampered', `${field} escapes its allowed root`);
}

export function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.kind === right.kind &&
    left.uid === right.uid
  );
}

export function sameFileSnapshot(left: FileIdentity, right: FileIdentity): boolean {
  return (
    sameIdentity(left, right) &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.modifiedAtMs === right.modifiedAtMs
  );
}

export function requireOwnedFile(
  identity: FileIdentity,
  expectedUid: number,
  expectedMode: number,
  field: string,
): void {
  if (
    identity.kind !== 'file' ||
    identity.uid !== expectedUid ||
    (identity.mode & 0o777) !== expectedMode
  ) {
    fail('tampered', `${field} has an unexpected owner or mode`);
  }
}

export function requirePositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('invalid_input', `${field} must be a positive safe integer`);
  }
}

export function validateFullResources(resources: FullResourceSpec | undefined): FullResourceSpec {
  if (!resources) fail('invalid_input', 'fullResources are required for full instances');
  if (!Number.isFinite(resources.cpuCores) || resources.cpuCores <= 0 || resources.cpuCores > 1_024) {
    fail('invalid_input', 'fullResources.cpuCores must be positive');
  }
  const serializedCpu = resources.cpuCores.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  if (serializedCpu === '0' || Number(serializedCpu) !== resources.cpuCores) {
    fail('invalid_input', 'fullResources.cpuCores must have at most six decimal places');
  }
  for (const field of ['memoryBytes', 'pids', 'rootfsBytes', 'tmpfsBytes', 'logBytes'] as const) {
    requirePositiveSafeInteger(resources[field], `fullResources.${field}`);
  }
  if (resources.logBytes > resources.rootfsBytes) {
    fail('invalid_input', 'fullResources.logBytes cannot exceed rootfsBytes');
  }
  if (resources.tmpfsBytes > resources.memoryBytes) {
    fail('invalid_input', 'fullResources.tmpfsBytes cannot exceed memoryBytes');
  }
  return resources;
}

interface JsonBudget {
  nodes: number;
  keys: number;
  stringBytes: number;
}

const MAX_JSON_NODES = 16_384;
const MAX_JSON_KEYS = 8_192;
const MAX_JSON_STRING_BYTES = 524_288;

export function assertPlainJson(
  value: unknown,
  field = 'runtimeConfig',
  depth = 0,
  budget: JsonBudget = { nodes: 0, keys: 0, stringBytes: 0 },
): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES) fail('invalid_input', `${field} contains too many values`);
  if (depth > 16) fail('invalid_input', `${field} is too deeply nested`);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    budget.stringBytes += Buffer.byteLength(value, 'utf8');
    if (budget.stringBytes > MAX_JSON_STRING_BYTES) fail('invalid_input', `${field} contains too much text`);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid_input', `${field} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) fail('invalid_input', `${field} contains too many array entries`);
    value.forEach((entry, index) => assertPlainJson(entry, `${field}[${index}]`, depth + 1, budget));
    return;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('invalid_input', `${field} must contain plain JSON values only`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 1_000) fail('invalid_input', `${field} contains too many object entries`);
  budget.keys += entries.length;
  if (budget.keys > MAX_JSON_KEYS) fail('invalid_input', `${field} contains too many keys`);
  for (const [key, nested] of entries) {
    if (!key || key.includes(NUL)) fail('invalid_input', `${field} contains an unsafe key`);
    budget.stringBytes += Buffer.byteLength(key, 'utf8');
    if (budget.stringBytes > MAX_JSON_STRING_BYTES) fail('invalid_input', `${field} contains too much text`);
    assertPlainJson(nested, `${field}.${key}`, depth + 1, budget);
  }
}

export function checkedNextGeneration(generation: number): number {
  requirePositiveSafeInteger(generation, 'generation');
  if (generation >= Number.MAX_SAFE_INTEGER) fail('conflict', 'instance generation cannot be incremented safely');
  return generation + 1;
}

export function validateArgv(executable: string, args: readonly string[]): void {
  validateAbsoluteRoot(executable, 'command executable');
  if (args.length > 64) fail('tampered', 'command argv is too large');
  for (const argument of args) {
    if (!argument || argument.includes(NUL) || Buffer.byteLength(argument, 'utf8') > 4_096) {
      fail('tampered', 'command argv contains an unsafe argument');
    }
  }
}
