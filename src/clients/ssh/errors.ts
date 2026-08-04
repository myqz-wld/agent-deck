import type {
  AgentDeckClientErrorCode,
  AgentDeckClientErrorData,
  JsonValue,
} from '@contracts/index';
import type { ProtocolErrorMessage } from '@protocol/messages';

export type SshTransportErrorCode =
  | 'cancelled'
  | 'child_exit_timeout'
  | 'connection_closed'
  | 'connection_failed'
  | 'handshake_timeout'
  | 'host_key_verification_failed'
  | 'in_flight_limit'
  | 'incompatible_handshake'
  | 'invalid_profile'
  | 'invalid_request'
  | 'not_connected'
  | 'protocol_violation'
  | 'replay_gap'
  | 'write_queue_limit';

export class SshTransportError extends Error {
  constructor(
    readonly code: SshTransportErrorCode,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SshTransportError';
  }
}

export class AgentDeckRemoteError extends Error implements AgentDeckClientErrorData {
  constructor(
    readonly code: AgentDeckClientErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly currentRevision: number | undefined,
    readonly details: JsonValue,
  ) {
    super(message);
    this.name = 'AgentDeckRemoteError';
  }
}

const HOST_KEY_FAILURE_PATTERNS = [
  /host key verification failed/i,
  /remote host identification has changed/i,
  /offending .* key in/i,
  /no .* host key is known/i,
];

export function isHostKeyFailure(stderr: string): boolean {
  return HOST_KEY_FAILURE_PATTERNS.some((pattern) => pattern.test(stderr));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function remoteErrorFromMessage(message: ProtocolErrorMessage): AgentDeckRemoteError {
  return new AgentDeckRemoteError(
    message.error.code,
    message.error.message,
    message.error.retryable,
    message.error.currentRevision ?? undefined,
    message.error.details,
  );
}

export function isRetryableSshWriteFailure(error: unknown): error is SshTransportError {
  return (
    error instanceof SshTransportError &&
    ['connection_failed', 'not_connected', 'write_queue_limit'].includes(error.code)
  );
}
