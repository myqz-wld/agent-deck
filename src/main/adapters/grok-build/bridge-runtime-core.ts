import type {
  AdapterSessionMode,
  AgentEvent,
  AgentProfileSource,
  GrokUsageWatermark,
  SessionRecord,
  UploadedAttachmentRef,
} from '@shared/types';

import {
  NOOP_GROK_BRIDGE_DIAGNOSTICS,
  type GrokBridgeDiagnostics,
} from './bridge-diagnostics-core';
import {
  NOOP_GROK_LIVE_RATE_OBSERVER,
  type GrokLiveRateObserver,
} from './live-token-rate-core';

export interface GrokBridgeSessionRecordPort {
  get(sessionId: string): SessionRecord | null;
  setAgentRuntimeProfile(sessionId: string, profile: {
    agentProfileName: string | null;
    agentProfileSource: AgentProfileSource | null;
    agentPluginDir: string | null;
  }): void;
  setRuntimeProvider(sessionId: string, provider: string | null): void;
  setModel(sessionId: string, model: string | null): void;
  setThinking(sessionId: string, thinking: string | null): void;
  setSessionMode(sessionId: string, mode: AdapterSessionMode | null): void;
  setGrokSandbox(sessionId: string, sandbox: string | null): void;
  setGrokUsageWatermark(
    sessionId: string,
    watermark: GrokUsageWatermark | null,
  ): void;
}

/** Desktop-owned effects used by the complete Grok bridge composition graph. */
export interface GrokBridgeRuntimeHost {
  readonly diagnostics: GrokBridgeDiagnostics;
  readonly liveRate: GrokLiveRateObserver;
  readonly records: GrokBridgeSessionRecordPort;
  transaction<T>(operation: () => T): T;
  publishSessionUpdated(sessionId: string): void;
  guardHandOffSourceIngress(args: GrokHandOffIngressArgs): boolean;
  hasPendingWorktreeTransition(sessionId: string): boolean;
  prepareBrowserRuntimeEnvironment?(applicationSessionId: string): Record<string, string> | null;
  refreshBrowserRuntime?(applicationSessionId: string): void;
  revokeBrowserRuntime?(applicationSessionId: string): void;
}

export interface GrokHandOffIngressArgs {
  sourceSessionId: string;
  text: string;
  attachments?: UploadedAttachmentRef[];
  emit: (event: AgentEvent) => void;
  replay: (sourceSessionId: string) => Promise<void>;
  bypassWorktreeTransition?: boolean;
}

const noopRecords: GrokBridgeSessionRecordPort = {
  get: () => null,
  setAgentRuntimeProfile: () => undefined,
  setRuntimeProvider: () => undefined,
  setModel: () => undefined,
  setThinking: () => undefined,
  setSessionMode: () => undefined,
  setGrokSandbox: () => undefined,
  setGrokUsageWatermark: () => undefined,
};

/** Explicit no-op seam for small unit contexts that do not own desktop persistence. */
export const NOOP_GROK_BRIDGE_RUNTIME_HOST: GrokBridgeRuntimeHost = {
  diagnostics: NOOP_GROK_BRIDGE_DIAGNOSTICS,
  liveRate: NOOP_GROK_LIVE_RATE_OBSERVER,
  records: noopRecords,
  transaction: (operation) => operation(),
  publishSessionUpdated: () => undefined,
  guardHandOffSourceIngress: () => false,
  hasPendingWorktreeTransition: () => false,
};
