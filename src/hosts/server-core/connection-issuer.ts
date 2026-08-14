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

import { parseServerCoreCredentialDocument } from './credential-file';

function appendLine(current: string, line: string): string {
  return `${current}${current.length > 0 && !current.endsWith('\n') ? '\n' : ''}${line}\n`;
}

export function issueServerCoreConnection(
  flags: Readonly<Record<string, string>>,
): void {
  const instanceId = requireLinuxInstanceId(flags['--instance'], 'instance');
  const credentialId = requireStableToken(flags['--credential'], 'credential');
  const credentialFile = readTrustedTextFile(
    requireAbsolutePath(flags['--credential-file'], 'credential-file'),
  );
  const authorizedKeys = readTrustedTextFile(
    requireAbsolutePath(flags['--authorized-keys'], 'authorized-keys'),
  );
  if (credentialFile.mode !== 0o600 || authorizedKeys.mode !== 0o600) {
    throw new Error('credential authority and authorized_keys must both be mode 0600');
  }
  const document = parseServerCoreCredentialDocument(
    JSON.parse(credentialFile.text),
    instanceId,
  );
  if (document.credentials.some((entry) => entry.credentialId === credentialId)) {
    throw new Error('credentialId is already registered');
  }
  if (authorizedKeys.text.includes(`--credential ${credentialId} `)) {
    throw new Error('authorized_keys already contains this credentialId');
  }
  const issue = prepareRemoteConnectionIssue({
    purpose: 'client',
    topology: 'full',
    instanceId,
    credentialId,
    label: flags['--label'],
    hostname: flags['--hostname'],
    port: requirePositiveInteger(Number(flags['--port']), 'port', 65_535),
    username: flags['--username'],
    hostKeyFile: flags['--host-key'],
    outputFile: flags['--output'],
  });
  const authorityNext = `${JSON.stringify({
    schemaVersion: 2,
    instanceId,
    credentials: [
      ...document.credentials,
      { credentialId, surface: 'desktop', status: 'active' },
    ],
  }, null, 2)}\n`;
  parseServerCoreCredentialDocument(JSON.parse(authorityNext), instanceId);
  const forcedKey = [
    'restrict,command="/opt/agent-deck/bin/agent-deck-server-core-bridge',
    `--instance ${instanceId}`,
    `--credential ${credentialId}`,
    '--surface desktop",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty',
    issue.publicKey,
  ].join(' ');
  commitRemoteConnectionIssue({
    outputFile: flags['--output'],
    encodedCredential: issue.encodedCredential,
    mutations: [
      { current: credentialFile, next: authorityNext },
      { current: authorizedKeys, next: appendLine(authorizedKeys.text, forcedKey) },
    ],
  });
}
