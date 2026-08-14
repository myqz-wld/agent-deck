import type {
  AgentDeckClient,
  AgentDeckClientErrorCode,
  AgentDeckEventEnvelope,
  AgentDeckSubscription,
  CoreMethodMap,
  DeploymentTopology,
  HostHello,
  JsonObject,
  JsonValue,
  PendingRequestDto,
  ProjectReferenceDto,
  SessionHistoryEntryDto,
  SessionConsoleSummaryDto,
} from '@contracts/index';

export const DEFAULT_FEISHU_CALLBACK_WINDOW_MS = 2_800;
export const DEFAULT_PENDING_PRESENTATION_LIFETIME_MS = 30 * 60 * 1_000;
export const MAX_FEISHU_CALLBACK_WINDOW_MS = 2_800;
export const FEISHU_PROVIDER_UUID_DEDUP_WINDOW_MS = 60 * 60 * 1_000;

export interface FeishuStableSubject {
  appId: string;
  tenantKey: string;
  openId: string;
}

export interface EnrolledFeishuCredential extends FeishuStableSubject {
  instanceId: string;
  credentialId: string;
  connectionScope: string;
  topology: Exclude<DeploymentTopology, 'standalone'>;
  status: 'active' | 'revoked';
  authority: 'owner-equivalent';
}

interface FeishuInboundBase extends FeishuStableSubject {
  schemaVersion: 1;
  eventId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  occurredAt: number;
  displayName?: string;
}

export interface FeishuMessageEvent extends FeishuInboundBase {
  kind: 'message';
  text: string;
}

export interface FeishuPendingAction {
  name: 'pending.respond';
  instanceId: string;
  credentialId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  sessionId: string;
  requestId: string;
  revision: number;
  contentDigest: string;
  action: 'accept' | 'approve' | 'deny' | 'reject' | 'submit';
  nonce: string;
  value?: JsonValue;
}

export interface FeishuCardActionEvent extends FeishuInboundBase {
  kind: 'card-action';
  action: FeishuPendingAction;
}

export type FeishuInboundEvent = FeishuMessageEvent | FeishuCardActionEvent;

export interface FeishuChatContext {
  instanceId: string;
  credentialId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  openId: string;
  activeSessionId: string | null;
  updatedAt: number;
}

export interface FeishuSubscriptionRecord {
  instanceId: string;
  credentialId: string;
  chatId: string;
  sessionId: string;
  status: 'active' | 'inactive';
  updatedAt: number;
}

export interface FeishuDeliveryRecord {
  instanceId: string;
  eventId: string;
  credentialId: string;
  chatId: string;
  status: 'deduplicated' | 'exhausted' | 'failed' | 'pending' | 'reconciling' | 'sent';
  attempts: number;
  phase: 'core' | 'pre-transport' | 'transport-invoked';
  transportSafety: 'safe' | 'unknown' | null;
  transportIdempotencyExpiresAt: number | null;
  attemptDeadlineAt: number;
  updatedAt: number;
}

export interface FeishuCursorRecord {
  instanceId: string;
  credentialId: string;
  chatId: string;
  revision: number;
  updatedAt: number;
}

export interface DeliveryClaim {
  record: FeishuDeliveryRecord;
  state: 'claimed' | 'duplicate' | 'exhausted' | 'in-progress' | 'reconciliation-required';
}

/** Metadata only. Implementations must never persist business payloads or rendered bodies. */
export interface FeishuGatewayStore {
  resolveCredential(subject: FeishuStableSubject): EnrolledFeishuCredential | null;
  listActiveCredentials(): readonly EnrolledFeishuCredential[];
  getContext(instanceId: string, credentialId: string, chatId: string): FeishuChatContext | null;
  listContexts(): readonly FeishuChatContext[];
  putContext(context: FeishuChatContext): void;
  getSubscription(
    instanceId: string,
    credentialId: string,
    chatId: string,
    sessionId: string,
  ): FeishuSubscriptionRecord | null;
  listSubscriptions(
    instanceId: string,
    credentialId: string,
    chatId: string,
  ): readonly FeishuSubscriptionRecord[];
  putSubscription(subscription: FeishuSubscriptionRecord): void;
  claimDelivery(
    record: Omit<
      FeishuDeliveryRecord,
      'attemptDeadlineAt' | 'attempts' | 'phase' | 'status' | 'transportIdempotencyExpiresAt' |
      'transportSafety'
    >,
    maximumEventAttempts: number,
    attemptLifetimeMs?: number,
  ): DeliveryClaim;
  markDeliveryPreTransport(
    instanceId: string,
    eventId: string,
    expectedAttempt: number,
    updatedAt: number,
  ): boolean;
  markDeliveryTransportInvoked(
    instanceId: string,
    eventId: string,
    expectedAttempt: number,
    safety: 'safe' | 'unknown',
    idempotencyExpiresAt: number | null,
    updatedAt: number,
  ): boolean;
  /**
   * Same-attempt CAS for proof that an invoked transport did not accept the event. Active attempts
   * return to pre-transport; a late proof may recover reconciling/exhausted to retryable failed.
   */
  markDeliveryNotAccepted(
    instanceId: string,
    eventId: string,
    expectedAttempt: number,
    updatedAt: number,
  ): boolean;
  finishDelivery(
    instanceId: string,
    eventId: string,
    expectedAttempt: number,
    status: Extract<FeishuDeliveryRecord['status'], 'failed' | 'reconciling' | 'sent'>,
    updatedAt: number,
  ): boolean;
  getDelivery(instanceId: string, eventId: string): FeishuDeliveryRecord | null;
  requireDeliveryReconciliation(
    instanceId: string,
    eventId: string,
    expectedAttempt: number,
    updatedAt: number,
  ): boolean;
  getCursor(instanceId: string, credentialId: string, chatId: string): FeishuCursorRecord | null;
  putCursor(cursor: FeishuCursorRecord): void;
  /** Deletes only old terminal delivery metadata; pending/reconciling evidence is retained. */
  pruneDeliveries(terminalBefore: number): number;
}

export interface FeishuClientFactoryInput {
  instanceId: string;
  credentialId: string;
  clientId: string;
  topology: Exclude<DeploymentTopology, 'standalone'>;
}

export type FeishuAgentDeckClientFactory = (
  input: FeishuClientFactoryInput,
) => AgentDeckClient<CoreMethodMap>;

export interface FeishuCardButton {
  label: string;
  action: FeishuPendingAction;
}

export interface FeishuPendingCard {
  title: string;
  requestId: string;
  sessionId: string;
  state: PendingRequestDto['status'];
  createdAt: number;
  presentedAt: number;
  expiresAt: number | null;
  presentationLifetimeMs: number;
  display: JsonObject;
  buttons: readonly FeishuCardButton[];
}

export interface FeishuOutboundMessage {
  eventId: string;
  instanceId: string;
  credentialId: string;
  chatId: string;
  kind: 'card-update' | 'notification' | 'reply';
  text: string;
  cards: readonly FeishuPendingCard[];
}

export interface FeishuTransportPort {
  /**
   * eventId is the logical provider idempotency key. Abort prevents later gateway calls and asks
   * an in-flight adapter to cancel, but cannot retract a provider send already accepted outside
   * this process. That ambiguous case remains reconciling and is never automatically resent.
   */
  deliver(
    message: FeishuOutboundMessage,
    attempt: FeishuDeliveryAttemptContext,
  ): Promise<void>;
  /** Allows retry after invocation only when the adapter/provider deduplicates eventId. */
  deliverySemantics?: 'event-id-idempotent' | 'unknown';
  /** Provider-guaranteed event-id deduplication horizon; absent means no safe post-crash resend. */
  deliveryIdempotencyWindowMs?: number;
}

/** A transport may throw this only when no provider send was accepted or could still be accepted. */
export class FeishuTransportNotAcceptedError extends Error {
  constructor() {
    super('Feishu transport definitely did not accept the delivery');
    this.name = 'FeishuTransportNotAcceptedError';
  }
}

export interface FeishuDeliveryAttemptContext {
  attempt: number;
  transportTry: number;
  deadlineAt: number;
  signal: AbortSignal;
  remainingMs(): number;
}

export interface PendingActionNonceBinding {
  instanceId: string;
  credentialId: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  sessionId: string;
  requestId: string;
  revision: number;
  contentDigest: string;
  action: FeishuPendingAction['action'];
}

/** Production adapters can implement this with a secret-backed MAC; the secret never enters gateway state. */
export interface PendingActionNoncePort {
  issue(binding: PendingActionNonceBinding): string;
  verify(binding: PendingActionNonceBinding, nonce: string): boolean;
}

export interface FeishuAuditRecord {
  at: number;
  eventId: string;
  instanceId: string | null;
  credentialId: string | null;
  chatId: string;
  operation: string;
  outcome: 'accepted' | 'rejected' | 'retryable-failure';
  code: string;
  revision: number | null;
}

export interface FeishuAuditPort {
  record(entry: FeishuAuditRecord): void;
}

export interface FeishuGatewayObserver {
  onError(entry: { code: string; operation: string; retryable: boolean }): void;
  onDeliveryDropped(entry: {
    chatId: string;
    revision: number;
    reason: 'delivery-exhausted' | 'queue-full';
  }): void;
}

export interface FeishuGatewayClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): { cancel(): void };
}

export interface FeishuGatewayLimits {
  maxEventBytes: number;
  maxTextBytes: number;
  maxOutputBytes: number;
  maxSessions: number;
  maxProjects: number;
  maxHistoryEntries: number;
  maxPendingCards: number;
  maxQueuedNotificationsPerChat: number;
  maxTransportAttemptsPerCallback: number;
  maxEventAttempts: number;
  maxPendingResults: number;
  maxCoreResponseBytes: number;
  maxCoreJsonDepth: number;
  maxCoreJsonEntries: number;
  maxCoreFieldBytes: number;
  maxSubscriptionsPerChat: number;
  maxNotificationCoreRequests: number;
  deliveryAttemptLifetimeMs: number;
  deliveryRetentionMs: number;
  maxActiveCredentials: number;
  maxPersistedContexts: number;
  maxConcurrentChatClients: number;
  maxNotificationLanes: number;
}

export interface FeishuGatewayBinding {
  appId: string;
  tenantKey: string;
  instanceId: string;
  topology: Exclude<DeploymentTopology, 'standalone'>;
}

export interface FeishuGatewayOptions {
  appVersion: string;
  binding: FeishuGatewayBinding;
  store: FeishuGatewayStore;
  clientFactory: FeishuAgentDeckClientFactory;
  transport: FeishuTransportPort;
  nonce: PendingActionNoncePort;
  audit?: FeishuAuditPort;
  observer?: FeishuGatewayObserver;
  clock?: FeishuGatewayClock;
  callbackWindowMs?: number;
  pendingPresentationLifetimeMs?: number;
  limits?: Partial<FeishuGatewayLimits>;
}

export interface FeishuCallbackResult {
  acknowledged: true;
  duplicate: boolean;
  code: string;
  toast: string;
}

export interface ConnectedFeishuClient {
  client: AgentDeckClient<CoreMethodMap>;
  hello: HostHello;
  subscription: AgentDeckSubscription | null;
}

export interface SessionConsoleView {
  text: string;
  sessions?: readonly SessionConsoleSummaryDto[];
  projects?: readonly ProjectReferenceDto[];
  history?: readonly SessionHistoryEntryDto[];
  pending?: readonly PendingRequestDto[];
  cards?: readonly FeishuPendingCard[];
  revision: number | null;
}

export interface ClassifiedGatewayError {
  code: AgentDeckClientErrorCode | string;
  retryable: boolean;
  message: string;
  currentRevision?: number;
}

export type NotificationEvent = Pick<
  AgentDeckEventEnvelope,
  'entityId' | 'instanceId' | 'kind' | 'revision'
>;
