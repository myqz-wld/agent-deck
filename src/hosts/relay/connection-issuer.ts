import {
  commitRemoteConnectionIssue,
  prepareRemoteConnectionIssue,
  readTrustedTextFile,
} from '@hosts/linux-runtime/connection-credential-issuer';
import {
  requireAbsolutePath,
  requireLinuxInstanceId,
  requirePositiveInteger,
  requireStableToken,
} from '@hosts/linux-runtime/validation';

import { parseRelayHeadlessConfig } from './headless-config';

function appendLine(current: string, line: string): string {
  return `${current}${current.length > 0 && !current.endsWith('\n') ? '\n' : ''}${line}\n`;
}

export function issueRelayConnection(flags: Readonly<Record<string, string>>): void {
  const instanceId = requireLinuxInstanceId(flags['--instance'], 'instance');
  const credentialId = requireStableToken(flags['--credential'], 'credential');
  const runtimeUid = requirePositiveInteger(Number(flags['--runtime-uid']), 'runtime-uid');
  const configFile = readTrustedTextFile(requireAbsolutePath(flags['--config'], 'config'));
  const authorizedKeys = readTrustedTextFile(
    requireAbsolutePath(flags['--authorized-keys'], 'authorized-keys'),
  );
  if (authorizedKeys.mode !== 0o600) throw new Error('authorized_keys must be mode 0600');
  const config = parseRelayHeadlessConfig(JSON.parse(configFile.text));
  if (config.instanceId !== instanceId) throw new Error('Relay config instance mismatch');
  if (config.credentials.some((entry) => entry.credentialId === credentialId)) {
    throw new Error('credentialId is already registered');
  }
  if (authorizedKeys.text.includes(`--credential ${credentialId} `)) {
    throw new Error('authorized_keys already contains this credentialId');
  }
  const issue = prepareRemoteConnectionIssue({
    topology: 'relay',
    instanceId,
    credentialId,
    label: flags['--label'],
    hostname: flags['--hostname'],
    port: requirePositiveInteger(Number(flags['--port']), 'port', 65_535),
    username: flags['--username'],
    hostKeyFile: flags['--host-key'],
    outputFile: flags['--output'],
  });
  const configNext = `${JSON.stringify({
    schemaVersion: 1,
    instanceId,
    tickIntervalMs: config.tickIntervalMs,
    plumbingModule: config.plumbingModule,
    credentials: [
      ...config.credentials.map((entry) => ({
        credentialId: entry.credentialId,
        instanceId: entry.instanceId,
        kind: entry.kind,
        publicKey: entry.publicKey,
        fingerprint: entry.fingerprint,
        status: entry.status,
        createdAt: entry.createdAt,
        revokedAt: entry.revokedAt,
      })),
      {
        credentialId,
        instanceId,
        kind: 'ssh-client',
        publicKey: issue.clientPublicKey,
        fingerprint: issue.clientFingerprint,
        status: 'active',
        createdAt: Date.now(),
        revokedAt: null,
      },
    ],
  }, null, 2)}\n`;
  parseRelayHeadlessConfig(JSON.parse(configNext));
  const forcedKey = [
    'restrict,command="/opt/agent-deck/bin/agent-deck-relay bridge',
    `--instance ${instanceId}`,
    `--credential ${credentialId}`,
    '--surface desktop-full',
    `--socket /run/user/${runtimeUid}/agent-deck-relay/${instanceId}/control.sock",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty`,
    issue.clientPublicKey,
  ].join(' ');
  commitRemoteConnectionIssue({
    outputFile: flags['--output'],
    encodedCredential: issue.encodedCredential,
    mutations: [
      { current: configFile, next: configNext },
      { current: authorizedKeys, next: appendLine(authorizedKeys.text, forcedKey) },
    ],
  });
}
