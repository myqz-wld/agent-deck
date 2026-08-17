import type { SessionModelControllerHost } from '@main/adapters/session-model-controller-core';
import type { AdapterHookServerPort } from '@main/adapters/types/adapter-context';
import type { CodexThinkingLevel } from '@shared/session-metadata';
import type {
  AgentEvent,
  CodexApprovalPolicy,
  ProviderUsageSnapshot,
  SessionAdapterId,
  SessionRecord,
  UploadedAttachmentRef,
} from '@shared/types';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';

import type { CodexAppServerClient } from '../app-server/client';
import type { CodexLiveRateHost } from './live-token-rate-core';

export interface CodexBridgeLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface CodexBridgeSessionPort {
  claimAsSdk(sessionId: string): void;
  releaseSdkClaim(sessionId: string): void;
  hasSdkClaim(sessionId: string): boolean;
  renameSdkSession(fromId: string, toId: string): void;
  updateCliSessionId(applicationSessionId: string, cliSessionId: string): void;
  delete(sessionId: string): Promise<void>;
  getCloseEpoch(sessionId: string): number;
  markClosed(sessionId: string): void;
  unarchive(sessionId: string): Promise<void>;
}

export interface CodexBridgeTokenPort {
  allocate(sessionId: string): string;
  get(token: string): string | null;
  release(sessionId: string): void;
}

export interface CodexBridgeSessionRecordPort {
  get(sessionId: string): SessionRecord | null;
  setCodexSandbox(sessionId: string, value: 'workspace-write' | 'read-only' | 'danger-full-access' | null): void;
  setCodexApprovalPolicy(sessionId: string, value: CodexApprovalPolicy | null): void;
  setRuntimeProvider(sessionId: string, value: string | null): void;
  setModel(sessionId: string, value: string | null): void;
  setThinking(sessionId: string, value: string | null): void;
  setExtraAllowWrite(sessionId: string, value: string[] | null): void;
  setNetworkAccessEnabled(sessionId: string, value: boolean | null): void;
  setAdditionalDirectories(sessionId: string, value: string[] | null): void;
  publishUpdated(sessionId: string): void;
}

export interface CodexBridgeConfigurationPort {
  readApplicationInstructions(): string | undefined;
  readConfiguredModel(): string | null;
  readConfiguredReasoningEffort(): CodexThinkingLevel | null;
  readProviderConfigOverrides(
    provider: string | null | undefined,
  ): CodexConfigObject | null;
  readDefaultSandbox(): 'workspace-write' | 'read-only' | 'danger-full-access';
  validateModelProvider(provider: string | null | undefined): void;
}

export interface CodexBridgeClientRegistryPort {
  ensureClient(options: {
    clients: Map<string, CodexAppServerClient>;
    sessionId: string;
    sessionToken: string;
    hookServer?: AdapterHookServerPort;
  }): CodexAppServerClient;
  invalidateForPathChange(
    clients: Map<string, CodexAppServerClient>,
    sessions: ReadonlyMap<string, unknown>,
  ): void;
  getUsageSnapshot(
    clients: ReadonlyMap<string, CodexAppServerClient>,
  ): Promise<ProviderUsageSnapshot>;
  renameClient(
    clients: Map<string, CodexAppServerClient>,
    oldId: string,
    newId: string,
  ): void;
}

export interface CodexHandOffIngressArgs {
  sourceSessionId: string;
  agentId: SessionAdapterId;
  text: string;
  attachments?: UploadedAttachmentRef[];
  emit: (event: AgentEvent) => void;
  replay: (sourceSessionId: string) => Promise<void>;
  bypassWorktreeTransition?: boolean;
}

/** Desktop-owned effects used by the complete Codex bridge composition graph. */
export interface CodexBridgeRuntimeHost {
  readonly sessions: CodexBridgeSessionPort;
  readonly tokens: CodexBridgeTokenPort;
  readonly records: CodexBridgeSessionRecordPort;
  readonly configuration: CodexBridgeConfigurationPort;
  readonly clientRegistry: CodexBridgeClientRegistryPort;
  readonly sessionModel: SessionModelControllerHost;
  readonly liveRate: CodexLiveRateHost;
  logger(scope: string): CodexBridgeLogger;
  observeIgnoredAppServerItemType(itemType: string): void;
  observeHeuristicStreamError(message: string): void;
  hasExactUserMessage(sessionId: string, text: string): boolean;
  guardHandOffSourceIngress(args: CodexHandOffIngressArgs): boolean;
  hasPendingWorktreeTransition(sessionId: string): boolean;
  deleteUploadIfExists(path: string): Promise<void>;
  disposeSessionBrowser(sessionId: string): Promise<void>;
}
