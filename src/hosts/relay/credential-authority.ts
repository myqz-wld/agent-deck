import {
  assertExactKeys,
  requireLinuxInstanceId,
  requireObject,
  requireStableToken,
} from '@hosts/linux-runtime/validation';

import type { CredentialMetadata } from './metadata';

export interface RelayCredentialAuthority {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly credentials: readonly CredentialMetadata[];
}

function credential(value: unknown, instanceId: string): CredentialMetadata {
  const object = requireObject(value, 'credential');
  assertExactKeys(object, [
    'createdAt',
    'credentialId',
    'fingerprint',
    'instanceId',
    'kind',
    'publicKey',
    'revokedAt',
    'status',
  ], 'credential');
  const credentialId = requireStableToken(object.credentialId, 'credentialId');
  if (object.instanceId !== instanceId) throw new Error('credential instance mismatch');
  if (!['ssh-client', 'feishu', 'relay-worker'].includes(String(object.kind))) {
    throw new Error('credential kind is invalid');
  }
  if (!['active', 'revoked'].includes(String(object.status))) {
    throw new Error('credential status is invalid');
  }
  if (
    typeof object.fingerprint !== 'string' ||
    typeof object.publicKey !== 'string' ||
    !Number.isSafeInteger(object.createdAt) ||
    (object.revokedAt !== null && !Number.isSafeInteger(object.revokedAt))
  ) {
    throw new Error('credential fields are invalid');
  }
  return {
    id: credentialId,
    instanceId,
    credentialId,
    kind: object.kind as CredentialMetadata['kind'],
    publicKey: object.publicKey,
    fingerprint: object.fingerprint,
    status: object.status as CredentialMetadata['status'],
    createdAt: object.createdAt as number,
    revokedAt: object.revokedAt as number | null,
  };
}

export function parseRelayCredentialAuthority(
  value: unknown,
  expectedInstanceId?: string,
): RelayCredentialAuthority {
  const object = requireObject(value, 'Relay credential authority');
  assertExactKeys(object, ['credentials', 'instanceId', 'schemaVersion'], 'Relay credential authority');
  if (object.schemaVersion !== 1) throw new Error('Relay credential authority schemaVersion must be 1');
  const instanceId = requireLinuxInstanceId(object.instanceId);
  if (expectedInstanceId !== undefined && instanceId !== expectedInstanceId) {
    throw new Error('Relay credential authority instance mismatch');
  }
  if (!Array.isArray(object.credentials) || object.credentials.length > 1_024) {
    throw new Error('Relay credentials are invalid');
  }
  const credentials = object.credentials.map((entry) => credential(entry, instanceId));
  if (new Set(credentials.map((entry) => entry.credentialId)).size !== credentials.length) {
    throw new Error('Relay credentials contain duplicates');
  }
  return Object.freeze({
    schemaVersion: 1,
    instanceId,
    credentials: Object.freeze(credentials),
  });
}

export function encodeRelayCredentialAuthority(
  instanceId: string,
  credentials: readonly CredentialMetadata[],
): string {
  const encoded = `${JSON.stringify({
    schemaVersion: 1,
    instanceId,
    credentials: credentials.map(({ id: _id, ...entry }) => entry),
  }, null, 2)}\n`;
  parseRelayCredentialAuthority(JSON.parse(encoded), instanceId);
  return encoded;
}
