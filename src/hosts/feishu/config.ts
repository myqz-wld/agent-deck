import { validateSshHostProfile, type SshHostProfile } from '@clients/ssh';
import {
  assertExactKeys,
  requireAbsolutePath,
  requireLinuxInstanceId,
  requireObject,
  requirePositiveInteger,
  requireStableToken,
} from '@hosts/linux-runtime/validation';

export interface FeishuSshCredentialConfig {
  readonly credentialId: string;
  readonly connectionScope: string;
  readonly identityFile: string;
}

export interface FeishuCoreSshConfig {
  readonly schemaVersion: 2;
  readonly topology: 'relay' | 'full';
  readonly instanceId: string;
  readonly appVersion: string;
  readonly hostname: string;
  readonly port: number;
  readonly username: string;
  readonly knownHostsFile: string;
  readonly hostKeyAlias: string | null;
  readonly credentials: readonly FeishuSshCredentialConfig[];
}

function credential(value: unknown): FeishuSshCredentialConfig {
  const object = requireObject(value, 'core SSH credential');
  assertExactKeys(
    object,
    ['connectionScope', 'credentialId', 'identityFile'],
    'core SSH credential',
  );
  const credentialId = requireStableToken(object.credentialId, 'credentialId');
  return Object.freeze({
    credentialId,
    connectionScope: requireStableToken(object.connectionScope, 'connectionScope'),
    identityFile: requireAbsolutePath(object.identityFile, 'identityFile'),
  });
}

function validateProfile(
  config: FeishuCoreSshConfig,
  credential: FeishuSshCredentialConfig,
): void {
  const profile: SshHostProfile = {
    id: 'feishu-config-check',
    label: 'Feishu Core',
    topology: config.topology,
    hostname: config.hostname,
    port: config.port,
    username: config.username,
    identityFile: credential.identityFile,
    knownHostsFile: config.knownHostsFile,
    accessSurface: 'feishu',
    expectedInstanceId: config.instanceId,
    expectedConnectionScope: credential.connectionScope,
    ...(config.hostKeyAlias === null ? {} : { hostKeyAlias: config.hostKeyAlias }),
    sshBinary: '/usr/bin/ssh',
  };
  validateSshHostProfile(profile);
}

export function parseFeishuCoreSshConfig(value: unknown): FeishuCoreSshConfig {
  const object = requireObject(value, 'Feishu Core SSH config');
  assertExactKeys(object, [
    'appVersion',
    'credentials',
    'hostKeyAlias',
    'hostname',
    'instanceId',
    'knownHostsFile',
    'port',
    'schemaVersion',
    'topology',
    'username',
  ], 'Feishu Core SSH config');
  if (object.schemaVersion !== 2) {
    throw new Error('Feishu Core SSH schemaVersion is unsupported');
  }
  const topology = object.topology === 'full' || object.topology === 'relay'
    ? object.topology
    : null;
  if (topology === null) {
    throw new Error('Feishu Core SSH topology is invalid');
  }
  if (!Array.isArray(object.credentials) || object.credentials.length > 1_000) {
    throw new Error('Feishu Core SSH credentials are invalid');
  }
  const credentials = Object.freeze(object.credentials.map(credential));
  if (
    new Set(credentials.map((entry) => entry.credentialId)).size !== credentials.length ||
    new Set(credentials.map((entry) => entry.identityFile)).size !== credentials.length ||
    new Set(credentials.map((entry) => entry.connectionScope)).size !== credentials.length
  ) {
    throw new Error('Feishu Core SSH credentials contain duplicates');
  }
  const hostKeyAlias = object.hostKeyAlias === null
    ? null
    : requireStableToken(object.hostKeyAlias, 'hostKeyAlias');
  const config: FeishuCoreSshConfig = Object.freeze({
    schemaVersion: 2,
    topology,
    instanceId: requireLinuxInstanceId(object.instanceId),
    appVersion: requireStableToken(object.appVersion, 'appVersion'),
    hostname: requireStableToken(object.hostname, 'hostname'),
    port: requirePositiveInteger(object.port, 'port', 65_535),
    username: requireStableToken(object.username, 'username'),
    knownHostsFile: requireAbsolutePath(object.knownHostsFile, 'knownHostsFile'),
    hostKeyAlias,
    credentials,
  });
  for (const entry of credentials) validateProfile(config, entry);
  return config;
}
