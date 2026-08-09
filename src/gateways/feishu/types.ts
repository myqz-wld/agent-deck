import type { Logger } from '@larksuiteoapi/node-sdk';
import type {
  FeishuAgentDeckClientFactory,
  FeishuAuditPort,
  FeishuCallbackResult,
  FeishuGatewayClock,
  FeishuGatewayObserver,
  FeishuInboundEvent,
} from '@gateways/im';

export type FeishuProductionTopology = 'relay' | 'server-core';

export interface FeishuConfiguredCredential {
  openId: string;
  credentialId: string;
  status: 'active' | 'revoked';
}

/** Secret-free, bounded production configuration. */
export interface FeishuProductionConfig {
  schemaVersion: 1;
  topology: FeishuProductionTopology;
  instanceId: string;
  appId: string;
  tenantKey: string;
  stateDirectory: string;
  appSecretFile: string;
  actionSecretFile: string;
  credentials: readonly FeishuConfiguredCredential[];
  callbackWindowMs: number;
  pendingPresentationLifetimeMs: number;
  startupTimeoutMs: number;
  reconnectTimeoutMs: number;
  shutdownTimeoutMs: number;
  handshakeTimeoutMs: number;
  pingTimeoutSeconds: number;
}

export interface FeishuProviderSource {
  eventId: string;
  chatId: string;
  messageId: string;
  kind: 'card-action' | 'message';
  occurredAt: number;
}

export interface MappedFeishuEvent {
  event: FeishuInboundEvent;
  source: FeishuProviderSource;
}

export interface FeishuOpenApiResponse {
  code?: number;
  data?: { message_id?: string };
}

/** Narrow seam over the exact official SDK calls used by this adapter. */
export interface FeishuOpenApiPort {
  reply(input: {
    messageId: string;
    content: string;
    messageType: 'interactive' | 'text';
    uuid: string;
  }): Promise<FeishuOpenApiResponse>;
  create(input: {
    chatId: string;
    content: string;
    messageType: 'interactive' | 'text';
    uuid: string;
  }): Promise<FeishuOpenApiResponse>;
  patchCard(input: { messageId: string; content: string }): Promise<FeishuOpenApiResponse>;
}

export interface FeishuSdkEventHandlers {
  onMessage(raw: unknown): Promise<unknown>;
  onCardAction(raw: unknown): Promise<unknown>;
}

export interface FeishuSdkConnectionCallbacks {
  onReady(): void;
  onError(): void;
  onReconnecting(): void;
  onReconnected(): void;
}

export interface FeishuSdkConnectionPort {
  start(handlers: FeishuSdkEventHandlers): Promise<void> | void;
  close(force: boolean): void;
}

export type FeishuSdkConnectionFactory = (
  callbacks: FeishuSdkConnectionCallbacks,
) => FeishuSdkConnectionPort;

export interface FeishuConnectionHealth {
  instanceId: string;
  state: 'connected' | 'failed' | 'reconnecting' | 'starting' | 'stopped';
  generation: number;
  reconnectAttempts: number;
  lastErrorCode: string | null;
  updatedAt: number;
}

export interface FeishuHealthStore {
  getHealth(instanceId: string): FeishuConnectionHealth | null;
  putHealth(health: FeishuConnectionHealth): void;
}

export interface FeishuOperationalAuditEntry {
  at: number;
  component: 'gateway' | 'runtime' | 'sdk';
  operation: string;
  outcome: 'accepted' | 'rejected' | 'retryable-failure';
  code: string;
  eventId: string | null;
  instanceId: string | null;
  credentialId: string | null;
  chatId: string | null;
  revision: number | null;
}

export type FeishuAuditSink = (entry: FeishuOperationalAuditEntry) => void;

export interface FeishuAuditBundle {
  audit: FeishuAuditPort;
  observer: FeishuGatewayObserver;
  sdkLogger: Logger;
  runtime(
    operation: string,
    outcome: FeishuOperationalAuditEntry['outcome'],
    code: string,
  ): void;
}

export interface FeishuGatewayRuntimePort {
  start(): Promise<void>;
  close(): Promise<void>;
  handle(raw: unknown): Promise<FeishuCallbackResult>;
}

export interface FeishuRuntimeFactoryOptions {
  configPath: string;
  appVersion: string;
  clientFactory: FeishuAgentDeckClientFactory;
  auditSink: FeishuAuditSink;
  clock?: FeishuGatewayClock;
  onFatal?: (code: string) => void;
}

export type LoadedFeishuRuntimeFactoryOptions = Omit<
  FeishuRuntimeFactoryOptions,
  'configPath'
>;
