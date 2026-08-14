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

import {
  encodeRelayCredentialAuthority,
  parseRelayCredentialAuthority,
} from './credential-authority';

function appendLine(current: string, line: string): string {
  return `${current}${current.length > 0 && !current.endsWith('\n') ? '\n' : ''}${line}\n`;
}

export function issueRelayWorkerConnection(flags: Readonly<Record<string, string>>): void {
  const instanceId = requireLinuxInstanceId(flags['--instance'], 'instance');
  const credentialId = requireStableToken(flags['--credential'], 'credential');
  const workerId = requireStableToken(flags['--worker'], 'worker');
  const runtimeUid = requirePositiveInteger(Number(flags['--runtime-uid']), 'runtime-uid');
  const authorityFile = readTrustedTextFile(requireAbsolutePath(flags['--authority'], 'authority'));
  const authorizedKeys = readTrustedTextFile(
    requireAbsolutePath(flags['--authorized-keys'], 'authorized-keys'),
  );
  if (authorizedKeys.mode !== 0o600) throw new Error('authorized_keys must be mode 0600');
  if (authorityFile.mode !== 0o600) throw new Error('Relay authority must be mode 0600');
  const authority = parseRelayCredentialAuthority(JSON.parse(authorityFile.text), instanceId);
  if (authority.credentials.some((entry) => entry.credentialId === credentialId)) {
    throw new Error('credentialId is already registered');
  }
  if (authority.credentials.some(
    (entry) => entry.kind === 'relay-worker' && entry.status === 'active',
  )) {
    throw new Error('Relay already has its one active Worker identity');
  }
  if (authorizedKeys.text.includes(`--credential ${credentialId} `)) {
    throw new Error('authorized_keys already contains this credentialId');
  }
  const issue = prepareRemoteConnectionIssue({
    purpose: 'worker',
    topology: 'relay',
    instanceId,
    credentialId,
    label: flags['--label'],
    hostname: flags['--hostname'],
    port: requirePositiveInteger(Number(flags['--port']), 'port', 65_535),
    username: flags['--username'],
    hostKeyFile: flags['--host-key'],
    outputFile: flags['--output'],
    workerId,
  });
  const createdAt = Date.now();
  const authorityNext = encodeRelayCredentialAuthority(instanceId, [
    ...authority.credentials,
    {
      id: credentialId,
      credentialId,
      instanceId,
      kind: 'relay-worker',
      publicKey: issue.publicKey,
      fingerprint: issue.fingerprint,
      status: 'active',
      createdAt,
      revokedAt: null,
    },
  ]);
  const forcedKey = [
    'restrict,command="/opt/agent-deck/bin/agent-deck-relay attach',
    `--instance ${instanceId}`,
    `--credential ${credentialId}`,
    `--socket /run/user/${runtimeUid}/agent-deck-relay/${instanceId}/control.sock`,
    `--worker ${workerId}",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty`,
    issue.publicKey,
  ].join(' ');
  commitRemoteConnectionIssue({
    outputFile: flags['--output'],
    encodedCredential: issue.encodedCredential,
    mutations: [
      { current: authorityFile, next: authorityNext },
      {
        current: authorizedKeys,
        next: appendLine(authorizedKeys.text, forcedKey),
      },
    ],
  });
}
