import type {
  ProviderInferenceBrokerRequest,
  ProviderInferenceBrokerResponse,
  ProviderSessionAdapterId,
} from '@contracts/index';

export interface ServerCoreProviderInferenceBinding {
  readonly adapterId: ProviderSessionAdapterId;
  readonly instanceId: string;
  readonly maxConcurrency: number;
  readonly maxDeadlineMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly method: 'POST';
  /** Small exact route set owned by one trusted Provider profile. */
  readonly paths: readonly string[];
  readonly processId: string;
  readonly providerId: string;
  readonly sessionId: string;
  readonly upstreamId: string;
}

/** Transport-authenticated peer identity, not fields trusted from an HTTP body. */
export interface ServerCoreProviderInferencePeer {
  readonly adapterId: ProviderSessionAdapterId;
  readonly endpointId: string;
  readonly instanceId: string;
  readonly processId: string;
  readonly providerId: string;
  readonly sessionId: string;
  readonly upstreamId: string;
}

export interface ServerCoreProviderInferenceEndpoint {
  readonly endpointId: string;
}

export interface ServerCoreProviderInferenceUpstreamTarget {
  readonly adapterId: ProviderSessionAdapterId;
  readonly instanceId: string;
  readonly method: 'POST';
  readonly path: string;
  readonly processId: string;
  readonly providerId: string;
  readonly sessionId: string;
  readonly upstreamId: string;
}

export interface ServerCoreProviderInferenceUpstreamInput
  extends ServerCoreProviderInferenceUpstreamTarget {
  readonly body: ProviderInferenceBrokerRequest['body'];
  readonly deadlineMs: number;
  readonly requestId: string;
  readonly signal: AbortSignal;
}

/** This trusted port owns credential lookup/injection. Its input deliberately has no auth field. */
export interface ServerCoreProviderInferenceUpstreamPort {
  isAvailable(target: ServerCoreProviderInferenceUpstreamTarget): Promise<boolean>;
  /** Implementations must settle promptly after `input.signal` aborts; broker authority remains
   * reserved until settlement even when the caller-facing deadline/cancellation has completed. */
  invoke(input: ServerCoreProviderInferenceUpstreamInput): Promise<ProviderInferenceBrokerResponse>;
}

export interface ServerCoreProviderInferenceBrokerPort {
  available(binding: ServerCoreProviderInferenceBinding): Promise<boolean>;
  open(binding: ServerCoreProviderInferenceBinding): Promise<ServerCoreProviderInferenceEndpoint>;
  invoke(
    peer: ServerCoreProviderInferencePeer,
    request: ProviderInferenceBrokerRequest,
    signal?: AbortSignal,
  ): Promise<ProviderInferenceBrokerResponse>;
  release(endpointId: string): void;
  releaseSession(sessionId: string): void;
  close(): void;
}

export type ServerCoreProviderInferenceErrorCode =
  | 'access-denied'
  | 'cancelled'
  | 'closed'
  | 'conflict'
  | 'deadline'
  | 'limit'
  | 'response-invalid'
  | 'unavailable';

export class ServerCoreProviderInferenceError extends Error {
  constructor(
    readonly code: ServerCoreProviderInferenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ServerCoreProviderInferenceError';
  }
}
