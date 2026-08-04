import { createHash, timingSafeEqual } from 'node:crypto';

import type { InstanceRecord, ManagedVersion } from './types';
import {
  assertPlainJson,
  fail,
  requirePositiveSafeInteger,
  validateFullResources,
  validateImage,
  validateInstanceId,
  validateTopology,
  validateVersion,
} from './validation';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function sortedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, sortedJsonValue(nested)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  assertPlainJson(value, 'json');
  return `${JSON.stringify(sortedJsonValue(value), null, 2)}\n`;
}

export function encodeJson(value: unknown, maxBytes = 1_048_576): Uint8Array {
  const encoded = encoder.encode(canonicalJson(value));
  if (encoded.byteLength > maxBytes) fail('invalid_input', 'encoded JSON exceeds its byte bound');
  return encoded;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function decodeUtf8(value: Uint8Array, field: string): string {
  try {
    return decoder.decode(value);
  } catch {
    fail('tampered', `${field} is not valid UTF-8`);
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const observed = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (observed.length !== wanted.length || observed.some((key, index) => key !== wanted[index])) {
    fail('tampered', `${field} has missing or extra fields`);
  }
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('tampered', `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateManagedVersion(value: unknown, field: string): ManagedVersion {
  const object = requireObject(value, field);
  exactKeys(
    object,
    [
      'version',
      'image',
      'unitSha256',
      'configSha256',
      'unitBackupPath',
      'configBackupPath',
      'fullResources',
      'createdAtMs',
    ],
    field,
  );
  if (
    typeof object.version !== 'string' ||
    typeof object.image !== 'string' ||
    typeof object.unitSha256 !== 'string' ||
    typeof object.configSha256 !== 'string' ||
    typeof object.unitBackupPath !== 'string' ||
    typeof object.configBackupPath !== 'string' ||
    typeof object.createdAtMs !== 'number' ||
    (object.fullResources !== null && (typeof object.fullResources !== 'object' || Array.isArray(object.fullResources)))
  ) {
    fail('tampered', `${field} contains invalid field types`);
  }
  validateVersion(object.version, `${field}.version`);
  validateImage(object.image);
  if (!/^[a-f0-9]{64}$/.test(object.unitSha256) || !/^[a-f0-9]{64}$/.test(object.configSha256)) {
    fail('tampered', `${field} contains an invalid artifact digest`);
  }
  requirePositiveSafeInteger(object.createdAtMs, `${field}.createdAtMs`);
  if (object.fullResources !== null) {
    const resources = object.fullResources as Record<string, unknown>;
    exactKeys(resources, ['cpuCores', 'memoryBytes', 'pids', 'rootfsBytes', 'tmpfsBytes', 'logBytes'], `${field}.fullResources`);
    const validated = Object.fromEntries(Object.entries(resources)) as unknown as import('./types').FullResourceSpec;
    validateFullResources(validated);
  }
  return object as unknown as ManagedVersion;
}

export function validateInstanceRecord(value: unknown): InstanceRecord {
  const object = requireObject(value, 'record');
  exactKeys(
    object,
    [
      'schemaVersion',
      'topology',
      'instanceId',
      'generation',
      'currentVersion',
      'previousVersion',
      'versions',
      'createdAtMs',
      'updatedAtMs',
    ],
    'record',
  );
  if (
    object.schemaVersion !== 1 ||
    typeof object.topology !== 'string' ||
    typeof object.instanceId !== 'string' ||
    typeof object.generation !== 'number' ||
    typeof object.currentVersion !== 'string' ||
    (object.previousVersion !== null && typeof object.previousVersion !== 'string') ||
    !Array.isArray(object.versions) ||
    typeof object.createdAtMs !== 'number' ||
    typeof object.updatedAtMs !== 'number'
  ) {
    fail('tampered', 'record contains invalid field types');
  }
  validateTopology(object.topology);
  validateInstanceId(object.instanceId);
  validateVersion(object.currentVersion, 'record.currentVersion');
  if (object.previousVersion !== null) validateVersion(object.previousVersion, 'record.previousVersion');
  requirePositiveSafeInteger(object.generation, 'record.generation');
  requirePositiveSafeInteger(object.createdAtMs, 'record.createdAtMs');
  requirePositiveSafeInteger(object.updatedAtMs, 'record.updatedAtMs');
  if (object.updatedAtMs < object.createdAtMs) fail('tampered', 'record timestamps are inconsistent');
  if (object.versions.length === 0 || object.versions.length > 64) {
    fail('tampered', 'record must retain between 1 and 64 recoverable versions');
  }
  const versions = object.versions.map((entry, index) => validateManagedVersion(entry, `record.versions[${index}]`));
  if (versions.some((entry) => object.topology === 'full' ? entry.fullResources === null : entry.fullResources !== null)) {
    fail('tampered', 'record resource policy does not match its topology');
  }
  const labels = new Set(versions.map((entry) => entry.version));
  if (labels.size !== versions.length || !labels.has(object.currentVersion)) {
    fail('tampered', 'record version set is duplicate or missing the current version');
  }
  if (object.previousVersion !== null && !labels.has(object.previousVersion)) {
    fail('tampered', 'record previousVersion is not recoverable');
  }
  return { ...(object as unknown as InstanceRecord), versions };
}

interface RecordEnvelope {
  readonly schemaVersion: 1;
  readonly record: InstanceRecord;
  readonly sha256: string;
}

export function encodeRecord(record: InstanceRecord): Uint8Array {
  validateInstanceRecord(record);
  const digest = sha256(canonicalJson(record));
  const envelope: RecordEnvelope = { schemaVersion: 1, record, sha256: digest };
  return encodeJson(envelope);
}

export function decodeRecord(bytes: Uint8Array): InstanceRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes, 'record'));
  } catch {
    fail('tampered', 'record is not valid JSON');
  }
  const envelope = requireObject(parsed, 'record envelope');
  exactKeys(envelope, ['schemaVersion', 'record', 'sha256'], 'record envelope');
  if (envelope.schemaVersion !== 1 || typeof envelope.sha256 !== 'string') {
    fail('tampered', 'record envelope has invalid fields');
  }
  const record = validateInstanceRecord(envelope.record);
  const observed = Buffer.from(envelope.sha256, 'hex');
  const expected = Buffer.from(sha256(canonicalJson(record)), 'hex');
  if (observed.length !== expected.length || !timingSafeEqual(observed, expected)) {
    fail('tampered', 'record checksum mismatch');
  }
  const canonical = encodeRecord(record);
  if (canonical.byteLength !== bytes.byteLength || !timingSafeEqual(Buffer.from(canonical), Buffer.from(bytes))) {
    fail('tampered', 'record envelope is not in its exact canonical form');
  }
  return record;
}
