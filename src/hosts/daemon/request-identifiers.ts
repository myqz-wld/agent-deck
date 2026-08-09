import { AgentDeckClientErrorCode } from '@contracts/index';
import type { ProtocolMessage } from '@protocol/index';

import { DaemonRequestError } from './types';

/** Local UTF-8 byte ceiling for one live protocol correlation id. */
export const MAX_DAEMON_REQUEST_ID_BYTES = 256;
/** Local UTF-8 byte ceiling for a mutation idempotency key. */
export const MAX_DAEMON_IDEMPOTENCY_KEY_BYTES = 512;

const UNSAFE_IDENTIFIER_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export function assertDaemonIdentifier(
  value: string,
  field: string,
  maxBytes: number,
): void {
  const bytes = Buffer.byteLength(value);
  if (bytes === 0 || bytes > maxBytes) {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.InvalidRequest,
      `${field} must contain 1-${maxBytes} UTF-8 bytes`,
    );
  }
  if (UNSAFE_IDENTIFIER_CHARACTER.test(value)) {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.InvalidRequest,
      `${field} must not contain control or line-separator characters`,
    );
  }
}

/** Validate client identifiers before any value can be reflected or used for dispatch. */
export function assertDaemonMessageIdentifiers(message: ProtocolMessage): void {
  switch (message.type) {
    case 'hello':
    case 'subscribe':
      assertDaemonIdentifier(message.requestId, 'requestId', MAX_DAEMON_REQUEST_ID_BYTES);
      return;
    case 'request':
      assertDaemonIdentifier(message.requestId, 'requestId', MAX_DAEMON_REQUEST_ID_BYTES);
      return;
    case 'cancel':
      assertDaemonIdentifier(message.requestId, 'requestId', MAX_DAEMON_REQUEST_ID_BYTES);
      assertDaemonIdentifier(
        message.targetRequestId,
        'targetRequestId',
        MAX_DAEMON_REQUEST_ID_BYTES,
      );
      return;
    case 'ping':
      assertDaemonIdentifier(message.nonce, 'nonce', MAX_DAEMON_REQUEST_ID_BYTES);
      return;
    case 'error':
    case 'event':
    case 'hello-result':
    case 'pong':
    case 'result':
      return;
  }
}
