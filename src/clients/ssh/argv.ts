import { isAbsolute } from 'node:path';

import { escapeOpenSshConfigValue } from '../../shared/open-ssh';
import { SshTransportError } from './errors';
import { isBoundedSingleLine, SSH_TEXT_LIMITS } from './limits';
import type { SshHostProfile } from './types';

const DEFAULT_CONNECT_TIMEOUT_SECONDS = 15;
const DEFAULT_SERVER_ALIVE_INTERVAL_SECONDS = 15;
const DEFAULT_SERVER_ALIVE_COUNT_MAX = 3;
export const AGENT_DECK_SSH_BRIDGE_COMMAND = 'agent-deck-bridge';

const SAFE_REMOTE_COMPONENT = /^[A-Za-z0-9._:-]+$/;
const SAFE_USERNAME = /^[A-Za-z0-9._-]+$/;

function requireText(value: string, field: string, maxBytes: number): void {
  if (!isBoundedSingleLine(value, maxBytes)) {
    throw new SshTransportError(
      'invalid_profile',
      `${field} must be non-empty, free of wire control characters, and at most ${maxBytes} UTF-8 bytes`,
    );
  }
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SshTransportError('invalid_profile', `${field} must be a positive integer`);
  }
}

export function validateSshHostProfile(profile: Readonly<SshHostProfile>): void {
  requireText(profile.id, 'profile.id', SSH_TEXT_LIMITS.profileId);
  requireText(profile.label, 'profile.label', SSH_TEXT_LIMITS.profileLabel);
  if (profile.topology !== 'server-core' && profile.topology !== 'relay') {
    throw new SshTransportError('invalid_profile', 'SSH profiles require a remote topology');
  }
  if (
    profile.accessSurface !== undefined &&
    profile.accessSurface !== 'desktop-full' &&
    profile.accessSurface !== 'feishu-session-console'
  ) {
    throw new SshTransportError('invalid_profile', 'profile.accessSurface is invalid');
  }
  if (
    !isBoundedSingleLine(profile.hostname, SSH_TEXT_LIMITS.hostname) ||
    !SAFE_REMOTE_COMPONENT.test(profile.hostname) ||
    profile.hostname.startsWith('-')
  ) {
    throw new SshTransportError('invalid_profile', 'profile.hostname is not a safe SSH host');
  }
  if (
    !isBoundedSingleLine(profile.username, SSH_TEXT_LIMITS.username) ||
    !SAFE_USERNAME.test(profile.username) ||
    profile.username.startsWith('-')
  ) {
    throw new SshTransportError('invalid_profile', 'profile.username is not a safe SSH user');
  }
  requirePositiveInteger(profile.port, 'profile.port');
  if (profile.port > 65_535) {
    throw new SshTransportError('invalid_profile', 'profile.port must be at most 65535');
  }
  requireText(profile.identityFile, 'profile.identityFile', SSH_TEXT_LIMITS.path);
  requireText(profile.knownHostsFile, 'profile.knownHostsFile', SSH_TEXT_LIMITS.path);
  if (!isAbsolute(profile.identityFile) || !isAbsolute(profile.knownHostsFile)) {
    throw new SshTransportError(
      'invalid_profile',
      'identityFile and knownHostsFile must be explicit absolute paths',
    );
  }
  if ([profile.identityFile, profile.knownHostsFile].some((path) => path.includes('%') || path.includes('${'))) {
    throw new SshTransportError(
      'invalid_profile',
      'identityFile and knownHostsFile cannot contain OpenSSH expansion tokens',
    );
  }
  if (profile.identityFile === profile.knownHostsFile) {
    throw new SshTransportError(
      'invalid_profile',
      'identityFile and knownHostsFile must be separate files',
    );
  }
  if (profile.expectedInstanceId !== undefined) {
    requireText(
      profile.expectedInstanceId,
      'profile.expectedInstanceId',
      SSH_TEXT_LIMITS.instanceId,
    );
  }
  if (profile.expectedAccessCredentialId !== undefined) {
    requireText(
      profile.expectedAccessCredentialId,
      'profile.expectedAccessCredentialId',
      SSH_TEXT_LIMITS.accessCredentialId,
    );
  }
  if (profile.hostKeyAlias !== undefined) {
    if (
      !isBoundedSingleLine(profile.hostKeyAlias, SSH_TEXT_LIMITS.instanceId) ||
      !SAFE_REMOTE_COMPONENT.test(profile.hostKeyAlias) ||
      profile.hostKeyAlias.startsWith('-')
    ) {
      throw new SshTransportError('invalid_profile', 'profile.hostKeyAlias is not safe');
    }
  }
  if (profile.hostKeyFingerprint !== undefined) {
    requireText(profile.hostKeyFingerprint, 'profile.hostKeyFingerprint', 128);
  }
  if (profile.sshBinary !== undefined) {
    requireText(profile.sshBinary, 'profile.sshBinary', SSH_TEXT_LIMITS.path);
  }
  for (const [field, value] of [
    ['profile.connectTimeoutSeconds', profile.connectTimeoutSeconds],
    ['profile.serverAliveIntervalSeconds', profile.serverAliveIntervalSeconds],
    ['profile.serverAliveCountMax', profile.serverAliveCountMax],
  ] as const) {
    if (value !== undefined) requirePositiveInteger(value, field);
  }
}

/**
 * Builds an argv-only OpenSSH invocation. A fixed safe command prevents an ordinary interactive
 * shell if server provisioning is wrong; authorized_keys/sshd ForceCommand still owns the bridge.
 */
export function buildOpenSshArgv(profile: Readonly<SshHostProfile>): readonly string[] {
  validateSshHostProfile(profile);
  const nullConfigFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const connectTimeout = profile.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS;
  const aliveInterval =
    profile.serverAliveIntervalSeconds ?? DEFAULT_SERVER_ALIVE_INTERVAL_SECONDS;
  const aliveCount = profile.serverAliveCountMax ?? DEFAULT_SERVER_ALIVE_COUNT_MAX;

  const argv = [
    '-F',
    nullConfigFile,
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${escapeOpenSshConfigValue(profile.knownHostsFile)}`,
    '-o',
    `GlobalKnownHostsFile=${nullConfigFile}`,
    '-o',
    'UpdateHostKeys=no',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'IdentityFile=none',
    '-i',
    profile.identityFile,
    '-o',
    'IdentityAgent=none',
    '-o',
    'PreferredAuthentications=publickey',
    '-o',
    'PasswordAuthentication=no',
    '-o',
    'KbdInteractiveAuthentication=no',
    '-o',
    'PubkeyAuthentication=yes',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'ProxyCommand=none',
    '-o',
    'ProxyJump=none',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    'ForwardX11Trusted=no',
    '-o',
    'PermitLocalCommand=no',
    '-o',
    'LocalCommand=none',
    '-o',
    'RemoteCommand=none',
    '-o',
    'RequestTTY=no',
    '-o',
    'Tunnel=no',
    '-o',
    'AddKeysToAgent=no',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPersist=no',
    '-o',
    'ControlPath=none',
    '-o',
    'EscapeChar=none',
    '-o',
    `ConnectTimeout=${connectTimeout}`,
    '-o',
    `ServerAliveInterval=${aliveInterval}`,
    '-o',
    `ServerAliveCountMax=${aliveCount}`,
    '-o',
    'TCPKeepAlive=no',
    '-p',
    String(profile.port),
  ];
  if (profile.hostKeyAlias) argv.push('-o', `HostKeyAlias=${profile.hostKeyAlias}`);
  argv.push('--', `${profile.username}@${profile.hostname}`, AGENT_DECK_SSH_BRIDGE_COMMAND);
  return Object.freeze(argv);
}
