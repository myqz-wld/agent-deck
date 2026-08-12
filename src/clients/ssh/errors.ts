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
  | 'ssh_authentication_failed'
  | 'ssh_endpoint_unreachable'
  | 'ssh_remote_command_failed'
  | 'ssh_transport_closed'
  | 'write_progress_timeout'
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

const SSH_AUTHENTICATION_FAILURE_PATTERNS = [
  /permission denied/i,
  /authentication failed/i,
  /no supported authentication methods available/i,
  /too many authentication failures/i,
  /sign_and_send_pubkey/i,
];

const SSH_ENDPOINT_FAILURE_PATTERNS = [
  /connection refused/i,
  /connection timed out/i,
  /operation timed out/i,
  /no route to host/i,
  /network is unreachable/i,
  /could not resolve hostname/i,
  /name or service not known/i,
];

const SSH_REMOTE_COMMAND_FAILURE_PATTERNS = [
  /administratively prohibited/i,
  /exec request failed/i,
  /shell request failed/i,
  /subsystem request failed/i,
  /remote command/i,
  /forced command/i,
  /control socket/i,
];

const SSH_TRANSPORT_CLOSED_PATTERNS = [
  /connection reset/i,
  /connection closed/i,
  /broken pipe/i,
  /connection to .* closed/i,
];

function matchesAny(stderr: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(stderr));
}

/** Converts OpenSSH diagnostics into a bounded category without exposing stderr content. */
export function classifySshExitFailure(
  stderr: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): SshTransportError {
  if (matchesAny(stderr, SSH_AUTHENTICATION_FAILURE_PATTERNS)) {
    return new SshTransportError(
      'ssh_authentication_failed',
      'SSH authentication was rejected by the remote endpoint',
      true,
    );
  }
  if (matchesAny(stderr, SSH_ENDPOINT_FAILURE_PATTERNS)) {
    return new SshTransportError(
      'ssh_endpoint_unreachable',
      'SSH endpoint could not be reached',
      true,
    );
  }
  if (matchesAny(stderr, SSH_REMOTE_COMMAND_FAILURE_PATTERNS)) {
    return new SshTransportError(
      'ssh_remote_command_failed',
      'SSH connected but the Agent Deck remote command was rejected',
      true,
    );
  }
  if (matchesAny(stderr, SSH_TRANSPORT_CLOSED_PATTERNS)) {
    return new SshTransportError(
      'ssh_transport_closed',
      'SSH transport was closed by the remote endpoint',
      true,
    );
  }
  return new SshTransportError(
    'connection_failed',
    `SSH bridge exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`,
    true,
  );
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
