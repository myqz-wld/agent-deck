import { createHash } from 'node:crypto';

import { requireLinuxInstanceId, requireStableToken } from './validation';

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const result = Buffer.allocUnsafe(4 + bytes.byteLength);
  result.writeUInt32BE(bytes.byteLength, 0);
  bytes.copy(result, 4);
  return result;
}

/** Stable anonymous scope for Core idempotency and channel isolation; it is not a credential id. */
export function deriveConnectionScope(instanceId: string, credentialId: string): string {
  requireLinuxInstanceId(instanceId);
  requireStableToken(credentialId, 'credentialId');
  const hash = createHash('sha256');
  hash.update('agent-deck-connection-scope-v1');
  hash.update(lengthPrefixed(instanceId));
  hash.update(lengthPrefixed(credentialId));
  return `scope-${hash.digest('base64url')}`;
}
