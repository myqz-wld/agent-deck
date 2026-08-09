import type { Duplex } from 'node:stream';

import type {
  AgentDeckClientErrorCode,
  AgentDeckEventEnvelope,
  AuthenticatedClientAccessContext,
  ClientHello,
  CoreMethod,
  JsonObject,
  JsonValue,
} from '@contracts/index';

export interface DaemonRequestInput {
  readonly access: AuthenticatedClientAccessContext;
  readonly requestId: string;
  readonly method: CoreMethod;
  readonly params: JsonObject;
  readonly idempotencyKey: string | null;
  readonly expectedRevision: number | null;
  readonly deadlineAt: number | null;
  readonly signal: AbortSignal;
}

export interface DaemonRequestResult {
  readonly result: JsonValue;
  readonly revision: number;
}

export interface DaemonEventSubscription {
  close(): Promise<void> | void;
}

export interface DaemonEventSubscriptionInput {
  readonly access: AuthenticatedClientAccessContext;
  readonly afterRevision: number;
  readonly signal: AbortSignal;
  readonly onEvent: (event: AgentDeckEventEnvelope) => void;
}

/**
 * Business execution stays behind this injected boundary. Implementations own transactional
 * idempotency, persisted revisions, replay retention, and all provider/session behavior.
 */
export interface DaemonCoreRuntime {
  readonly supportedMethods: readonly CoreMethod[];
  start(): Promise<void>;
  stop(reason: string): Promise<void>;
  currentRevision(access: AuthenticatedClientAccessContext): Promise<number> | number;
  execute(input: DaemonRequestInput): Promise<DaemonRequestResult>;
  subscribe?(input: DaemonEventSubscriptionInput): Promise<DaemonEventSubscription>;
}

/** Created by the authenticated transport, never deserialized from a protocol request. */
export type DaemonAccessContextFactory = (
  hello: ClientHello,
) => Promise<AuthenticatedClientAccessContext> | AuthenticatedClientAccessContext;

export interface DaemonConnectionAdmission {
  readonly stream: Duplex;
  readonly createAccessContext: DaemonAccessContextFactory;
  readonly label?: string;
}

export interface DaemonListener {
  start(
    onConnection: (stream: Duplex) => void,
    onFailure?: (error: Error) => void,
  ): Promise<void>;
  stop(): Promise<void>;
}

export interface DaemonConnectionLimits {
  readonly maxFrameBytes: number;
  readonly maxBlobBytes: number;
  readonly maxConcurrentRequests: number;
  readonly maxQueuedRequests: number;
  readonly maxQueuedEvents: number;
  readonly maxQueuedFrames: number;
  /** Total encoded bytes awaiting write completion for one connection. */
  readonly maxQueuedBytes: number;
  readonly maxPendingMessages: number;
  readonly protocolCloseGraceMs: number;
}

export const DEFAULT_DAEMON_CONNECTION_LIMITS: DaemonConnectionLimits = Object.freeze({
  maxFrameBytes: 4 * 1024 * 1024,
  maxBlobBytes: 16 * 1024 * 1024,
  maxConcurrentRequests: 8,
  maxQueuedRequests: 32,
  maxQueuedEvents: 256,
  maxQueuedFrames: 288,
  maxQueuedBytes: 32 * 1024 * 1024,
  maxPendingMessages: 64,
  protocolCloseGraceMs: 100,
});

export class DaemonRequestError extends Error {
  constructor(
    readonly code: AgentDeckClientErrorCode,
    message: string,
    readonly retryable = false,
    readonly currentRevision: number | null = null,
    readonly details: JsonValue = null,
  ) {
    super(message);
    this.name = 'DaemonRequestError';
  }
}
