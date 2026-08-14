import {
  assertExactKeys,
  requireAbsolutePath,
  requireObject,
  requireStableToken,
} from '@hosts/linux-runtime/validation';

export interface FeishuConnectRequest {
  readonly schemaVersion: 1;
  readonly appId: string;
  readonly tenantKey: string;
  readonly credentialId: string;
  readonly label: string;
  readonly appSecretFile: string;
}

export interface FeishuDisconnectRequest {
  readonly schemaVersion: 1;
  readonly credentialId: string;
}

export interface FeishuRotateCredentialRequest {
  readonly schemaVersion: 1;
  readonly credentialId: string;
  readonly nextCredentialId: string;
  readonly label: string;
}

function bounded(value: unknown, field: string, maximum = 256): string {
  if (
    typeof value !== 'string' || value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximum ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  ) throw new Error(`${field} is invalid`);
  return value;
}

export function parseFeishuConnectRequest(value: unknown): FeishuConnectRequest {
  const object = requireObject(value, 'Feishu connect request');
  assertExactKeys(object, [
    'appId', 'appSecretFile', 'credentialId', 'label', 'schemaVersion', 'tenantKey',
  ], 'Feishu connect request');
  if (object.schemaVersion !== 1) throw new Error('Feishu connect schemaVersion is unsupported');
  const appId = bounded(object.appId, 'appId');
  if (!/^cli_[0-9a-fA-F]{16}$/u.test(appId)) throw new Error('appId is invalid');
  const tenantKey = bounded(object.tenantKey, 'tenantKey');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/$-]*$/u.test(tenantKey)) {
    throw new Error('tenantKey is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    appId,
    tenantKey,
    credentialId: requireStableToken(object.credentialId, 'credentialId'),
    label: bounded(object.label, 'label'),
    appSecretFile: requireAbsolutePath(object.appSecretFile, 'appSecretFile'),
  });
}

export function parseFeishuDisconnectRequest(value: unknown): FeishuDisconnectRequest {
  const object = requireObject(value, 'Feishu disconnect request');
  assertExactKeys(object, ['credentialId', 'schemaVersion'], 'Feishu disconnect request');
  if (object.schemaVersion !== 1) {
    throw new Error('Feishu disconnect schemaVersion is unsupported');
  }
  return Object.freeze({
    schemaVersion: 1,
    credentialId: requireStableToken(object.credentialId, 'credentialId'),
  });
}

export function parseFeishuRotateCredentialRequest(
  value: unknown,
): FeishuRotateCredentialRequest {
  const object = requireObject(value, 'Feishu credential rotation request');
  assertExactKeys(object, [
    'credentialId', 'label', 'nextCredentialId', 'schemaVersion',
  ], 'Feishu credential rotation request');
  if (object.schemaVersion !== 1) {
    throw new Error('Feishu credential rotation schemaVersion is unsupported');
  }
  const credentialId = requireStableToken(object.credentialId, 'credentialId');
  const nextCredentialId = requireStableToken(object.nextCredentialId, 'nextCredentialId');
  if (credentialId === nextCredentialId) throw new Error('Feishu rotation requires a new id');
  return Object.freeze({
    schemaVersion: 1,
    credentialId,
    nextCredentialId,
    label: bounded(object.label, 'label'),
  });
}
