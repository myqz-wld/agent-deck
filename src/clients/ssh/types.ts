import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';

import type { DeploymentTopology, HostHello } from '@contracts/index';

export type RemoteDeploymentTopology = Exclude<DeploymentTopology, 'standalone'>;

export interface SshHostProfile {
  id: string;
  label: string;
  topology: RemoteDeploymentTopology;
  hostname: string;
  port: number;
  username: string;
  identityFile: string;
  knownHostsFile: string;
  accessSurface?: 'desktop-full' | 'feishu-session-console';
  expectedInstanceId?: string;
  expectedAccessCredentialId?: string;
  hostKeyAlias?: string;
  hostKeyFingerprint?: string;
  sshBinary?: string;
  connectTimeoutSeconds?: number;
  serverAliveIntervalSeconds?: number;
  serverAliveCountMax?: number;
}

export interface StrictSshSpawnOptions extends SpawnOptionsWithoutStdio {
  shell: false;
  stdio: ['pipe', 'pipe', 'pipe'];
  windowsHide: true;
}

export type SpawnSshProcess = (
  binary: string,
  argv: readonly string[],
  options: StrictSshSpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface SshReconnectPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  maxAttempts: number;
}

export interface SshTransportBounds {
  maxFrameBytes: number;
  maxInFlightRequests: number;
  maxQueuedRequests: number;
  maxQueuedWriteBytes: number;
  maxQueuedWriteFrames: number;
  maxRememberedResponses: number;
  maxStderrBytes: number;
}

export interface SshTransportTiming {
  handshakeTimeoutMs: number;
  pingIntervalMs: number;
  pongTimeoutMs: number;
  childExitGraceMs: number;
  childExitKillWaitMs: number;
}

export interface SshTransportOptions {
  spawn?: SpawnSshProcess;
  reconnect?: Partial<SshReconnectPolicy>;
  bounds?: Partial<SshTransportBounds>;
  timing?: Partial<SshTransportTiming>;
  now?: () => number;
  createRequestId?: () => string;
}

export type SshConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'incompatible'
  | 'offline'
  | 'closed';

export interface SshConnectionState {
  profileId: string;
  topology: RemoteDeploymentTopology;
  status: SshConnectionStatus;
  attempt: number;
  hello: HostHello | null;
  reason: string | null;
  errorCode: string | null;
}

export interface SshStateSubscription {
  close(): void;
}

export interface SshRequestOptions {
  requestId?: string;
  idempotencyKey?: string;
  expectedRevision?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
}
