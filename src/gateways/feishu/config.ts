import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { FeishuGatewayError, MAX_FEISHU_CALLBACK_WINDOW_MS } from '@gateways/im';
import type {
  FeishuConfiguredCredential,
  FeishuProductionConfig,
  FeishuProductionTopology,
} from './types';

const CONFIG_FIELDS = [
  'actionSecretFile', 'appId', 'appSecretFile', 'callbackWindowMs', 'credentials',
  'handshakeTimeoutMs', 'instanceId', 'pendingPresentationLifetimeMs',
  'pingTimeoutSeconds', 'reconnectTimeoutMs', 'schemaVersion', 'shutdownTimeoutMs',
  'startupTimeoutMs', 'stateDirectory', 'tenantKey', 'topology',
] as const;
const CREDENTIAL_FIELDS = ['credentialId', 'openId', 'status'] as const;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/$-]*$/;
const APP_ID = /^cli_[0-9a-fA-F]{16}$/;
const INSTANCE_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f-\u009f]/u;

function fail(message: string): never {
  throw new FeishuGatewayError('invalid_configuration', message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) fail(`${label} contains an unsupported field`);
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) fail(`${label} is incomplete`);
  }
}

function token(value: unknown, label: string, maximum = 256): string {
  if (
    typeof value !== 'string' || value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximum || !TOKEN.test(value)
  ) return fail(`${label} is invalid`);
  return value;
}

function duration(value: unknown, label: string, maximum: number, allowZero = false): number {
  if (
    !Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1) ||
    (value as number) > maximum
  ) return fail(`${label} is outside the production bound`);
  return value as number;
}

function protectedFile(path: string, maximumBytes: number): Buffer {
  if (!isAbsolute(path) || Buffer.byteLength(path, 'utf8') > 4_096) {
    fail('Protected file path is invalid');
  }
  let descriptor: number | null = null;
  let readBuffer: Buffer | null = null;
  try {
    if (realpathSync(path) !== path) fail('Protected file path is not canonical');
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) fail('Protected file is not regular');
    if (before.uid !== process.geteuid?.()) fail('Protected file owner is invalid');
    if ((before.mode & 0o777) !== 0o600) fail('Protected file mode must be 0600');
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const after = fstatSync(descriptor);
    const finalPath = lstatSync(path);
    if (
      realpathSync(path) !== path ||
      after.dev !== before.dev || after.ino !== before.ino ||
      finalPath.dev !== after.dev || finalPath.ino !== after.ino ||
      after.size > maximumBytes
    ) {
      fail('Protected file changed or exceeds its size bound');
    }
    readBuffer = Buffer.allocUnsafe(maximumBytes + 1);
    const bytesRead = readSync(descriptor, readBuffer, 0, readBuffer.byteLength, 0);
    const finalDescriptor = fstatSync(descriptor);
    if (
      bytesRead > maximumBytes ||
      finalDescriptor.size !== after.size ||
      bytesRead !== finalDescriptor.size
    ) fail('Protected file changed or exceeds its size bound');
    return Buffer.from(readBuffer.subarray(0, bytesRead));
  } catch (error) {
    if (error instanceof FeishuGatewayError) throw error;
    return fail('Protected file could not be verified');
  } finally {
    readBuffer?.fill(0);
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function assertFeishuStateDirectory(path: string): void {
  if (!isAbsolute(path) || Buffer.byteLength(path, 'utf8') > 4_096) {
    fail('State directory path is invalid');
  }
  try {
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('State directory is invalid');
    if (metadata.uid !== process.geteuid?.()) fail('State directory owner is invalid');
    if ((metadata.mode & 0o777) !== 0o700) fail('State directory mode must be 0700');
    if (realpathSync(path) !== path) fail('State directory path is not canonical');
  } catch (error) {
    if (error instanceof FeishuGatewayError) throw error;
    fail('State directory could not be verified');
  }
}

function parseCredential(value: unknown): FeishuConfiguredCredential {
  const record = object(value, 'credential');
  exact(record, CREDENTIAL_FIELDS, 'credential');
  if (!['active', 'revoked'].includes(String(record.status))) fail('Credential status is invalid');
  return {
    openId: token(record.openId, 'credential.openId'),
    credentialId: token(record.credentialId, 'credential.credentialId'),
    status: record.status as FeishuConfiguredCredential['status'],
  };
}

function parseConfig(value: unknown): FeishuProductionConfig {
  const record = object(value, 'config');
  exact(record, CONFIG_FIELDS, 'config');
  if (record.schemaVersion !== 1) fail('Config schemaVersion is unsupported');
  if (!['relay', 'server-core'].includes(String(record.topology))) fail('Topology is invalid');
  if (!Array.isArray(record.credentials) || record.credentials.length > 1_000) {
    fail('Credentials are outside the production bound');
  }
  const credentials = record.credentials.map(parseCredential);
  if (
    new Set(credentials.map((item) => item.openId)).size !== credentials.length ||
    new Set(credentials.map((item) => item.credentialId)).size !== credentials.length
  ) fail('Credential enrollment contains duplicates');
  const appId = token(record.appId, 'appId');
  if (!APP_ID.test(appId)) fail('appId is invalid');
  if (typeof record.instanceId !== 'string' || !INSTANCE_ID.test(record.instanceId)) {
    fail('instanceId must be a lowercase ASCII label of 1-63 letters, digits, or interior hyphens');
  }
  const instanceId = record.instanceId;
  const stateDirectory = String(record.stateDirectory);
  const appSecretFile = String(record.appSecretFile);
  const actionSecretFile = String(record.actionSecretFile);
  if (
    ![stateDirectory, appSecretFile, actionSecretFile].every(isAbsolute) ||
    new Set([appSecretFile, actionSecretFile]).size !== 2
  ) fail('Production paths must be absolute and distinct');
  return {
    schemaVersion: 1,
    topology: record.topology as FeishuProductionTopology,
    instanceId,
    appId,
    tenantKey: token(record.tenantKey, 'tenantKey'),
    stateDirectory,
    appSecretFile,
    actionSecretFile,
    credentials,
    callbackWindowMs: duration(
      record.callbackWindowMs,
      'callbackWindowMs',
      MAX_FEISHU_CALLBACK_WINDOW_MS,
    ),
    pendingPresentationLifetimeMs: duration(
      record.pendingPresentationLifetimeMs,
      'pendingPresentationLifetimeMs',
      7 * 24 * 60 * 60 * 1_000,
      true,
    ),
    startupTimeoutMs: duration(record.startupTimeoutMs, 'startupTimeoutMs', 120_000),
    reconnectTimeoutMs: duration(record.reconnectTimeoutMs, 'reconnectTimeoutMs', 300_000),
    shutdownTimeoutMs: duration(record.shutdownTimeoutMs, 'shutdownTimeoutMs', 60_000),
    handshakeTimeoutMs: duration(record.handshakeTimeoutMs, 'handshakeTimeoutMs', 60_000),
    pingTimeoutSeconds: duration(record.pingTimeoutSeconds, 'pingTimeoutSeconds', 120),
  };
}

export function loadFeishuProductionConfig(path: string): FeishuProductionConfig {
  const bytes = protectedFile(path, 65_536);
  try {
    try {
      return parseConfig(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      if (error instanceof FeishuGatewayError) throw error;
      return fail('Production config is not valid JSON');
    }
  } finally {
    bytes.fill(0);
  }
}

function secret(path: string): Buffer {
  const raw = protectedFile(path, 1_026);
  try {
    const value = raw.toString('utf8').replace(/\r?\n$/u, '');
    if (
      Buffer.byteLength(value, 'utf8') < 32 || Buffer.byteLength(value, 'utf8') > 1_024 ||
      CONTROL_OR_SPACE.test(value)
    ) fail('Protected secret has an invalid format');
    return Buffer.from(value, 'utf8');
  } finally {
    raw.fill(0);
  }
}

export function withFeishuSecretMaterial<T>(
  config: FeishuProductionConfig,
  consume: (appSecret: string, actionSecret: Uint8Array) => T,
): T {
  assertFeishuStateDirectory(config.stateDirectory);
  const appSecret = secret(config.appSecretFile);
  try {
    const actionSecret = secret(config.actionSecretFile);
    try {
      return consume(appSecret.toString('utf8'), actionSecret);
    } finally {
      actionSecret.fill(0);
    }
  } finally {
    appSecret.fill(0);
  }
}

export function feishuDatabasePath(config: FeishuProductionConfig): string {
  return join(config.stateDirectory, 'metadata.sqlite3');
}
