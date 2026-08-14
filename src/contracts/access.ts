import type { DeploymentTopology } from './topology';
import type { RemoteOwnerGrantClaim } from './grant-policy';

export const AccessSurface = {
  Desktop: 'desktop',
  Feishu: 'feishu',
  RelayWorker: 'relay-worker',
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
  surface: 'desktop';
}

interface AuthenticatedClientAccessContextBase {
  kind: 'authenticated-client';
  topology: Exclude<DeploymentTopology, 'standalone'>;
  instanceId: string;
  clientId: string;
  connectionScope: string;
  authority: 'owner-equivalent';
  grant: RemoteOwnerGrantClaim;
}

export interface AuthenticatedSshAccessContext
  extends AuthenticatedClientAccessContextBase {
  transport: 'ssh';
  surface: 'desktop';
}

export interface AuthenticatedFeishuAccessContext
  extends AuthenticatedClientAccessContextBase {
  transport: 'feishu';
  surface: 'feishu';
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
  surface: 'relay-worker';
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
