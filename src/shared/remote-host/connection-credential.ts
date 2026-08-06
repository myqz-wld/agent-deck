import type { RemoteHostRemoteTopology } from './types';

export const REMOTE_CONNECTION_CREDENTIAL_KIND = 'agent-deck-remote-connection-credential';
export const REMOTE_CONNECTION_CREDENTIAL_SCHEMA_VERSION = 1;

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const SAFE_HOST = /^[A-Za-z0-9._:-]+$/;
const SAFE_USER = /^[A-Za-z0-9._-]+$/;
const STABLE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const INSTANCE_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PUBLIC_KEY = /^[A-Za-z0-9+/]+={0,2}$/;
const PRIVATE_KEY = /^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END OPENSSH PRIVATE KEY-----\n?$/;
const HOST_KEY_ALGORITHMS = new Set([
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ecdsa-sha2-nistp256@openssh.com',
  'sk-ssh-ed25519@openssh.com',
  'ssh-ed25519',
  'ssh-rsa',
]);

export interface RemoteConnectionHostKey {
  algorithm: string;
  publicKey: string;
}

export interface RemoteConnectionCredential {
  schemaVersion: typeof REMOTE_CONNECTION_CREDENTIAL_SCHEMA_VERSION;
  kind: typeof REMOTE_CONNECTION_CREDENTIAL_KIND;
  label: string;
  topology: RemoteHostRemoteTopology;
  instanceId: string;
  credentialId: string;
  endpoint: {
    hostname: string;
    port: number;
    username: string;
  };
  hostKeys: RemoteConnectionHostKey[];
  identity: {
    algorithm: 'ssh-ed25519';
    privateKey: string;
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${field} contains missing or unexpected fields`);
  }
}

function boundedText(value: unknown, field: string, maxBytes: number): string {
  if (
    typeof value !== 'string' || value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maxBytes || CONTROL.test(value)
  ) {
    throw new Error(`${field} is invalid or too long`);
  }
  return value;
}

function parseHostKey(value: unknown, index: number): RemoteConnectionHostKey {
  const field = `hostKeys[${index}]`;
  const raw = record(value, field);
  exactKeys(raw, ['algorithm', 'publicKey'], field);
  const algorithm = boundedText(raw.algorithm, `${field}.algorithm`, 64);
  const publicKey = boundedText(raw.publicKey, `${field}.publicKey`, 16 * 1024);
  if (!HOST_KEY_ALGORITHMS.has(algorithm) || !PUBLIC_KEY.test(publicKey) ||
      !publicKeyMatchesAlgorithm(publicKey, algorithm)) {
    throw new Error(`${field} is not a supported OpenSSH host key`);
  }
  return { algorithm, publicKey };
}

function publicKeyMatchesAlgorithm(publicKey: string, algorithm: string): boolean {
  const bytes = Buffer.from(publicKey, 'base64');
  if (
    bytes.byteLength < 4 ||
    bytes.toString('base64').replace(/=+$/u, '') !== publicKey.replace(/=+$/u, '')
  ) return false;
  const length = bytes.readUInt32BE(0);
  if (length < 1 || length > 64 || 4 + length > bytes.byteLength) return false;
  return bytes.subarray(4, 4 + length).toString('ascii') === algorithm;
}

export function parseRemoteConnectionCredential(value: unknown): RemoteConnectionCredential {
  const raw = record(value, 'connection credential');
  exactKeys(raw, [
    'credentialId', 'endpoint', 'hostKeys', 'identity', 'instanceId', 'kind',
    'label', 'schemaVersion', 'topology',
  ], 'connection credential');
  if (raw.schemaVersion !== REMOTE_CONNECTION_CREDENTIAL_SCHEMA_VERSION) {
    throw new Error('connection credential schemaVersion is unsupported');
  }
  if (raw.kind !== REMOTE_CONNECTION_CREDENTIAL_KIND) {
    throw new Error('connection credential kind is invalid');
  }
  if (raw.topology !== 'server-core' && raw.topology !== 'relay') {
    throw new Error('connection credential topology is invalid');
  }
  const label = boundedText(raw.label, 'connection credential label', 256);
  const instanceId = boundedText(raw.instanceId, 'connection credential instanceId', 63);
  const credentialId = boundedText(raw.credentialId, 'connection credential credentialId', 160);
  if (!INSTANCE_ID.test(instanceId)) throw new Error('connection credential instanceId is invalid');
  if (!STABLE_TOKEN.test(credentialId)) throw new Error('connection credential credentialId is invalid');
  const endpoint = record(raw.endpoint, 'connection credential endpoint');
  exactKeys(endpoint, ['hostname', 'port', 'username'], 'connection credential endpoint');
  const hostname = boundedText(endpoint.hostname, 'connection credential hostname', 253);
  const username = boundedText(endpoint.username, 'connection credential username', 128);
  if (!SAFE_HOST.test(hostname) || hostname.startsWith('-')) {
    throw new Error('connection credential hostname is invalid');
  }
  if (!SAFE_USER.test(username) || username.startsWith('-')) {
    throw new Error('connection credential username is invalid');
  }
  if (!Number.isSafeInteger(endpoint.port) || (endpoint.port as number) < 1 ||
      (endpoint.port as number) > 65_535) {
    throw new Error('connection credential port is invalid');
  }
  if (!Array.isArray(raw.hostKeys) || raw.hostKeys.length < 1 || raw.hostKeys.length > 8) {
    throw new Error('connection credential hostKeys are invalid');
  }
  const hostKeys = raw.hostKeys.map(parseHostKey);
  const identities = hostKeys.map((key) => `${key.algorithm}\u0000${key.publicKey}`);
  if (new Set(identities).size !== identities.length) {
    throw new Error('connection credential hostKeys contain duplicates');
  }
  const identity = record(raw.identity, 'connection credential identity');
  exactKeys(identity, ['algorithm', 'privateKey'], 'connection credential identity');
  if (identity.algorithm !== 'ssh-ed25519' || typeof identity.privateKey !== 'string' ||
      new TextEncoder().encode(identity.privateKey).byteLength > 32 * 1024 ||
      !PRIVATE_KEY.test(identity.privateKey)) {
    throw new Error('connection credential identity is invalid');
  }
  return {
    schemaVersion: REMOTE_CONNECTION_CREDENTIAL_SCHEMA_VERSION,
    kind: REMOTE_CONNECTION_CREDENTIAL_KIND,
    label,
    topology: raw.topology,
    instanceId,
    credentialId,
    endpoint: { hostname, port: endpoint.port as number, username },
    hostKeys,
    identity: { algorithm: 'ssh-ed25519', privateKey: identity.privateKey },
  };
}

function knownHostsHost(hostname: string, port: number): string {
  return port === 22 && !hostname.includes(':') ? hostname : `[${hostname}]:${port}`;
}

export function renderRemoteConnectionKnownHosts(credential: RemoteConnectionCredential): string {
  const host = knownHostsHost(credential.endpoint.hostname, credential.endpoint.port);
  return `${credential.hostKeys
    .map((key) => `${host} ${key.algorithm} ${key.publicKey}`)
    .join('\n')}\n`;
}
