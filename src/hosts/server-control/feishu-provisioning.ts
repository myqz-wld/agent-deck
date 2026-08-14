import { parseFeishuProductionConfig } from '@gateways/feishu/config';
import { parseFeishuCoreSshConfig } from '@hosts/feishu/config';
import type { PrivateTextOutput } from '@hosts/linux-runtime/connection-credential-issuer';
import {
  renderRemoteConnectionKnownHosts,
  type RemoteConnectionClientCredential,
} from '@shared/remote-host';
import type { ServerControlConfig } from './config';
import type { FeishuConnectRequest } from './feishu-request';

export interface FeishuProvisioningPaths {
  readonly configDirectory: string;
  readonly stateDirectory: string;
  readonly gatewayConfig: string;
  readonly coreSshConfig: string;
  readonly appSecret: string;
  readonly actionSecret: string;
  readonly knownHosts: string;
  readonly identity: string;
  readonly managementSocket: string;
  readonly serviceUnit: string;
  readonly runtimeRoot: string;
  readonly runtimeReleases: string;
  readonly runtimeActive: string;
  readonly runtimeDesired: string;
}

export const PRODUCTION_FEISHU_PATHS: FeishuProvisioningPaths = Object.freeze({
  configDirectory: '/etc/agent-deck-feishu',
  stateDirectory: '/var/lib/agent-deck-feishu',
  gatewayConfig: '/etc/agent-deck-feishu/config.json',
  coreSshConfig: '/etc/agent-deck-feishu/core-ssh.json',
  appSecret: '/etc/agent-deck-feishu/app-secret',
  actionSecret: '/etc/agent-deck-feishu/action-secret',
  knownHosts: '/etc/agent-deck-feishu/core-known-hosts',
  identity: '/etc/agent-deck-feishu/core-credential.key',
  managementSocket: '/run/agent-deck-feishu/control.sock',
  serviceUnit: 'agent-deck-feishu.service',
  runtimeRoot: '/opt/agent-deck/feishu-runtime',
  runtimeReleases: '/opt/agent-deck/feishu-runtime/releases',
  runtimeActive: '/opt/agent-deck/feishu-runtime/active',
  runtimeDesired: '/opt/agent-deck/feishu-runtime/desired',
});

export const FEISHU_PROTECTED_FILES = Object.freeze([
  'gatewayConfig', 'coreSshConfig', 'appSecret', 'actionSecret', 'knownHosts', 'identity',
] as const);

function encoded(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function renderFeishuProvisioning(input: {
  config: ServerControlConfig;
  request: FeishuConnectRequest;
  credential: RemoteConnectionClientCredential;
  appSecret: string;
  actionSecret: string;
  paths: FeishuProvisioningPaths;
}): { readonly outputs: readonly PrivateTextOutput[] } {
  const owner = input.config.feishuIdentityOwner;
  const gateway = parseFeishuProductionConfig({
    schemaVersion: 3,
    topology: input.config.topology,
    instanceId: input.config.instanceId,
    appId: input.request.appId,
    tenantKey: input.request.tenantKey,
    stateDirectory: input.paths.stateDirectory,
    appSecretFile: input.paths.appSecret,
    actionSecretFile: input.paths.actionSecret,
    managementSocketPath: input.paths.managementSocket,
    credentials: [{
      openId: null,
      credentialId: input.credential.credentialId,
      connectionScope: input.credential.connectionScope,
      replacesCredentialId: null,
      status: 'active',
    }],
    callbackWindowMs: 2_800,
    pendingPresentationLifetimeMs: 1_800_000,
    startupTimeoutMs: 15_000,
    reconnectTimeoutMs: 120_000,
    shutdownTimeoutMs: 10_000,
    handshakeTimeoutMs: 10_000,
    pingTimeoutSeconds: 45,
  });
  const core = parseFeishuCoreSshConfig({
    schemaVersion: 2,
    topology: input.config.topology,
    instanceId: input.config.instanceId,
    appVersion: input.config.appVersion,
    hostname: input.credential.endpoint.hostname,
    port: input.credential.endpoint.port,
    username: input.credential.endpoint.username,
    knownHostsFile: input.paths.knownHosts,
    hostKeyAlias: null,
    credentials: [{
      credentialId: input.credential.credentialId,
      connectionScope: input.credential.connectionScope,
      identityFile: input.paths.identity,
    }],
  });
  const texts = new Map<keyof Pick<FeishuProvisioningPaths,
  typeof FEISHU_PROTECTED_FILES[number]>, string>([
    ['gatewayConfig', encoded(gateway)],
    ['coreSshConfig', encoded(core)],
    ['appSecret', input.appSecret],
    ['actionSecret', input.actionSecret],
    ['knownHosts', renderRemoteConnectionKnownHosts(input.credential)],
    ['identity', input.credential.identity.privateKey],
  ]);
  return Object.freeze({
    outputs: Object.freeze(FEISHU_PROTECTED_FILES.map((field) => Object.freeze({
      path: input.paths[field],
      text: texts.get(field) as string,
      mode: 0o600 as const,
      uid: owner.uid,
      gid: owner.gid,
    }))),
  });
}
