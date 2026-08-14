import { createHash } from 'node:crypto';

import { SshAgentDeckClient, type SshTransportOptions } from '@clients/ssh';
import { FeishuGatewayError, type FeishuAgentDeckClientFactory } from '@gateways/im';
import type { FeishuProductionConfig } from '@gateways/feishu';

import type { FeishuCoreSshConfig } from './config';

function hashId(...components: string[]): string {
  const hash = createHash('sha256');
  for (const component of components) {
    const bytes = Buffer.from(component, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    hash.update(length);
    hash.update(bytes);
  }
  return `feishu-${hash.digest('base64url')}`;
}

export function createFeishuSshClientFactory(
  gateway: FeishuProductionConfig,
  ssh: FeishuCoreSshConfig,
  options: SshTransportOptions = {},
): FeishuAgentDeckClientFactory {
  if (gateway.instanceId !== ssh.instanceId || gateway.topology !== ssh.topology) {
    throw new FeishuGatewayError(
      'invalid_configuration',
      'Feishu Gateway and Core SSH bindings do not match',
    );
  }
  const active = new Map(
    gateway.credentials
      .filter((credential) => credential.status === 'active')
      .map((credential) => [credential.credentialId, credential.connectionScope]),
  );
  const identities = new Map(
    ssh.credentials.map((credential) => [credential.credentialId, credential]),
  );
  if (
    active.size !== identities.size ||
    [...active].some(([credentialId, connectionScope]) =>
      identities.get(credentialId)?.connectionScope !== connectionScope)
  ) {
    throw new FeishuGatewayError(
      'invalid_configuration',
      'Active Feishu credentials do not have an exact SSH identity binding',
    );
  }
  return (input) => {
    const identity = identities.get(input.credentialId);
    if (
      input.instanceId !== gateway.instanceId || input.topology !== gateway.topology ||
      !active.has(input.credentialId) || !identity
    ) {
      throw new FeishuGatewayError('access_denied', 'Feishu Core credential is not active');
    }
    return new SshAgentDeckClient({
      id: hashId(input.instanceId, input.credentialId, input.clientId),
      label: 'Feishu Core',
      topology: input.topology,
      hostname: ssh.hostname,
      port: ssh.port,
      username: ssh.username,
      identityFile: identity.identityFile,
      knownHostsFile: ssh.knownHostsFile,
      accessSurface: 'feishu',
      expectedInstanceId: input.instanceId,
      expectedConnectionScope: identity.connectionScope,
      ...(ssh.hostKeyAlias === null ? {} : { hostKeyAlias: ssh.hostKeyAlias }),
      sshBinary: '/usr/bin/ssh',
    }, options);
  };
}
