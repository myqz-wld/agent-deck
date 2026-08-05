import { isAbsolute } from 'node:path';

export interface LocalWorkerSshConfig {
  sshBinary: string;
  host: string;
  port: number;
  user: string;
  identityFile: string;
  knownHostsFile: string;
  instanceId: string;
  workerId: string;
  credentialId: string;
  connectTimeoutSeconds: number;
}

export interface WorkerEnrollmentRequest {
  instanceId: string;
  workerId: string;
  credentialId: string;
  publicKey: string;
  fingerprint: string;
}

const HOST_TOKEN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\]|[0-9A-Fa-f:]+)$/;
const USER_TOKEN = /^[A-Za-z_][A-Za-z0-9._-]{0,63}$/;
const IDENTIFIER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/;
const INSTANCE_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function assertToken(value: string, field: string): void {
  if (
    value.length === 0 ||
    value.length > 255 ||
    value.startsWith('-') ||
    /[\0\r\n\s]/.test(value)
  ) {
    throw new Error(`${field} must be a bounded token`);
  }
}

function assertPattern(value: string, field: string, pattern: RegExp): void {
  assertToken(value, field);
  if (!pattern.test(value)) throw new Error(`${field} has invalid token syntax`);
}

function assertOpenSshPath(value: string, field: string): void {
  if (!isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw new Error(`${field} must be an absolute local path`);
  }
  if (/[%$]/.test(value)) {
    throw new Error(`${field} cannot contain OpenSSH expansion tokens`);
  }
}

function quoteOpenSshValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function assertLocalWorkerSshConfig(config: LocalWorkerSshConfig): void {
  assertToken(config.sshBinary, 'sshBinary');
  assertPattern(config.host, 'host', HOST_TOKEN);
  assertPattern(config.user, 'user', USER_TOKEN);
  assertPattern(config.instanceId, 'instanceId', INSTANCE_ID);
  assertPattern(config.workerId, 'workerId', IDENTIFIER_TOKEN);
  assertPattern(config.credentialId, 'credentialId', IDENTIFIER_TOKEN);
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new Error('port must be a valid TCP port');
  }
  if (
    !Number.isSafeInteger(config.connectTimeoutSeconds) ||
    config.connectTimeoutSeconds < 1 ||
    config.connectTimeoutSeconds > 600
  ) {
    throw new Error('connectTimeoutSeconds must be between 1 and 600');
  }
  assertOpenSshPath(config.identityFile, 'identityFile');
  assertOpenSshPath(config.knownHostsFile, 'knownHostsFile');
}

/**
 * Builds only an outbound, host-key-pinned stdio attachment. No listen, tunnel, agent, X11,
 * user environment, or interactive shell capability is requested.
 */
export function buildLocalWorkerSshArgv(config: LocalWorkerSshConfig): string[] {
  assertLocalWorkerSshConfig(config);
  return [
    '-F',
    '/dev/null',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'IdentityFile=none',
    '-o',
    'IdentityAgent=none',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${quoteOpenSshValue(config.knownHostsFile)}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'UpdateHostKeys=no',
    '-o',
    'PreferredAuthentications=publickey',
    '-o',
    'PubkeyAuthentication=yes',
    '-o',
    'PasswordAuthentication=no',
    '-o',
    'KbdInteractiveAuthentication=no',
    '-o',
    'HostbasedAuthentication=no',
    '-o',
    'GSSAPIAuthentication=no',
    '-o',
    'ProxyCommand=none',
    '-o',
    'ProxyJump=none',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPersist=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    'ForwardX11Trusted=no',
    '-o',
    'Tunnel=no',
    '-o',
    'PermitLocalCommand=no',
    '-o',
    'LocalCommand=none',
    '-o',
    'RemoteCommand=none',
    '-o',
    'AddKeysToAgent=no',
    '-o',
    'EscapeChar=none',
    '-o',
    'TCPKeepAlive=no',
    '-o',
    'RequestTTY=no',
    '-o',
    `ConnectTimeout=${config.connectTimeoutSeconds}`,
    '-p',
    String(config.port),
    '-i',
    config.identityFile,
    '--',
    `${config.user}@${config.host}`,
    'agent-deck-relay',
    'attach',
    '--instance',
    config.instanceId,
    '--credential',
    config.credentialId,
    '--worker',
    config.workerId,
  ];
}

/** Private key bytes/path stay local; the Relay enrollment boundary accepts public material only. */
export function createWorkerEnrollmentRequest(input: WorkerEnrollmentRequest): WorkerEnrollmentRequest {
  assertPattern(input.instanceId, 'instanceId', INSTANCE_ID);
  for (const field of ['workerId', 'credentialId'] as const) {
    assertPattern(input[field], field, IDENTIFIER_TOKEN);
  }
  assertToken(input.fingerprint, 'fingerprint');
  if (
    !input.publicKey.startsWith('ssh-') ||
    input.publicKey.length > 8192 ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(input.publicKey)
  ) {
    throw new Error('publicKey must contain OpenSSH public material only');
  }
  return { ...input };
}
