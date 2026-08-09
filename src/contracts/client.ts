import type { ClientHello, HostHello } from './capabilities';
import type { JsonValue } from './json';

export interface AgentDeckMethodDefinition<Params = unknown, Result = unknown> {
  params: Params;
  result: Result;
}

export type AgentDeckMethodMap = Record<
  string,
  AgentDeckMethodDefinition<unknown, unknown>
>;

type MethodParams<Methods, Method extends keyof Methods> = Methods[Method] extends {
  params: infer Params;
}
  ? Params
  : never;

type MethodResult<Methods, Method extends keyof Methods> = Methods[Method] extends {
  result: infer Result;
}
  ? Result
  : never;

export interface AgentDeckRequestOptions {
  requestId?: string;
  idempotencyKey?: string;
  expectedRevision?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface AgentDeckEventEnvelope {
  instanceId: string;
  revision: number;
  kind: string;
  entityId: string | null;
  payload: JsonValue;
}

export interface AgentDeckSubscription {
  close(): void;
}

export interface AgentDeckClient<Methods = AgentDeckMethodMap> {
  connect(hello: ClientHello): Promise<HostHello>;

  request<Method extends keyof Methods & string>(
    method: Method,
    params: MethodParams<Methods, Method>,
    options?: AgentDeckRequestOptions,
  ): Promise<MethodResult<Methods, Method>>;

  subscribe(
    afterRevision: number,
    listener: (event: AgentDeckEventEnvelope) => void,
  ): AgentDeckSubscription;

  close(): Promise<void>;
}

export const AgentDeckClientErrorCode = {
  AccessDenied: 'access_denied',
  AlreadyDecided: 'already_decided',
  Cancelled: 'cancelled',
  CapabilityUnavailable: 'capability_unavailable',
  Conflict: 'conflict',
  DeadlineExceeded: 'deadline_exceeded',
  IncompatibleProtocol: 'incompatible_protocol',
  InternalError: 'internal_error',
  InvalidRequest: 'invalid_request',
  NotFound: 'not_found',
  ProviderLost: 'provider_lost',
  ReplayGap: 'replay_gap',
  Revoked: 'revoked',
  WorkerOffline: 'worker_offline',
} as const;

export type AgentDeckClientErrorCode =
  (typeof AgentDeckClientErrorCode)[keyof typeof AgentDeckClientErrorCode];

export interface AgentDeckClientErrorData {
  code: AgentDeckClientErrorCode;
  message: string;
  retryable: boolean;
  currentRevision?: number;
  details?: JsonValue;
}
