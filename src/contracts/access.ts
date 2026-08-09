import type { DeploymentTopology } from './topology';

export const AccessSurface = {
  DesktopFull: 'desktop-full',
  FeishuSessionConsole: 'feishu-session-console',
  RelayWorkerAttach: 'relay-worker-attach',
} as const;

export type AccessSurface = (typeof AccessSurface)[keyof typeof AccessSurface];

export type AccessCredentialKind = 'ssh-client' | 'feishu' | 'relay-worker';

export interface StandaloneAccessContext {
  kind: 'standalone';
  topology: 'standalone';
  instanceId: 'local';
  clientId: string;
  transport: 'local-ipc';
  accessCredentialId: null;
  authority: 'local-owner';
  surface: 'desktop-full';
}

interface AuthenticatedClientAccessContextBase {
  kind: 'authenticated-client';
  topology: Exclude<DeploymentTopology, 'standalone'>;
  instanceId: string;
  clientId: string;
  accessCredentialId: string;
  authority: 'owner-equivalent';
}

export interface AuthenticatedSshAccessContext
  extends AuthenticatedClientAccessContextBase {
  transport: 'ssh';
  surface: 'desktop-full';
}

export interface AuthenticatedFeishuAccessContext
  extends AuthenticatedClientAccessContextBase {
  transport: 'feishu';
  surface: 'feishu-session-console';
}

export type AuthenticatedClientAccessContext =
  | AuthenticatedSshAccessContext
  | AuthenticatedFeishuAccessContext;

export interface RelayWorkerAccessContext {
  kind: 'relay-worker';
  topology: 'relay';
  instanceId: string;
  clientId: string;
  transport: 'ssh';
  accessCredentialId: string;
  credentialKind: 'relay-worker';
  authority: 'worker-attach-only';
  surface: 'relay-worker-attach';
  workerId: string;
  generation: number;
}

export type AccessContext =
  | StandaloneAccessContext
  | AuthenticatedClientAccessContext
  | RelayWorkerAccessContext;

export function isOwnerEquivalentClient(
  context: AccessContext,
): context is AuthenticatedClientAccessContext {
  return context.kind === 'authenticated-client' && context.authority === 'owner-equivalent';
}
