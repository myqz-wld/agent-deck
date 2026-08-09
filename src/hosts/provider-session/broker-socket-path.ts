import { createHash } from 'node:crypto';
import { isAbsolute, join, normalize } from 'node:path';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const MAX_UNIX_SOCKET_PATH_BYTES = 103;

/** Shared Core/host derivation: opaque endpoint ids never become attacker-chosen socket names. */
export function providerSessionBrokerSocketPath(brokerRoot: string, endpointId: string): string {
  if (!isAbsolute(brokerRoot) || normalize(brokerRoot) !== brokerRoot || brokerRoot === '/' ||
      brokerRoot.includes('\0') || !TOKEN.test(endpointId)) {
    throw new Error('provider broker socket identity is invalid');
  }
  const digest = createHash('sha256').update(endpointId).digest('hex').slice(0, 20);
  const path = join(brokerRoot, `b-${digest}.sock`);
  if (Buffer.byteLength(path) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error('provider broker socket path exceeds its portable bound');
  }
  return path;
}
