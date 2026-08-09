import type { AgentEvent } from '@shared/types';
import type { SessionManagerHost } from '@main/session/manager/facade-core';
import type { GrokSessionSetupOptions } from './session-setup';
import type { GrokBridgeRuntimeHost } from './bridge-runtime-core';
import type { GrokAcpSessionFactory } from './acp-process';

export type GrokSessionManagerPort = Pick<
  SessionManagerHost,
  | 'claimAsSdk'
  | 'releaseSdkClaim'
  | 'delete'
  | 'markClosed'
  | 'updateCliSessionId'
>;

export interface GrokBuildBridgeOptions extends GrokSessionSetupOptions {
  runtimeHost: GrokBridgeRuntimeHost;
  emit: (event: AgentEvent) => void;
  sessionManager: GrokSessionManagerPort;
  reportStartupCleanupFailure(sessionId: string, error: unknown): void;
  onNegotiatedImageCapability?: (supported: boolean) => void;
  permissionTimeoutMs: number;
  binaryPath?: string | null;
  processFactory?: GrokAcpSessionFactory;
}
