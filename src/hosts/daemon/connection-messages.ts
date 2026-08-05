import type { AgentDeckEventEnvelope } from '@contracts/index';
import {
  assertProtocolMessageEnvelope,
  type HostProtocolMessage,
  type ProtocolErrorMessage,
} from '@protocol/index';

import type { DaemonRequestError } from './types';

export function daemonRequestErrorMessage(
  requestId: string,
  error: DaemonRequestError,
): ProtocolErrorMessage {
  return {
    type: 'error',
    requestId,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      currentRevision: error.currentRevision,
      details: error.details,
    },
  };
}

export function daemonEventMessage(
  event: AgentDeckEventEnvelope,
  instanceId: string,
  lastRevision: number,
): HostProtocolMessage {
  if (
    event.instanceId !== instanceId ||
    !Number.isSafeInteger(event.revision) ||
    event.revision <= lastRevision
  ) {
    throw new Error('Core event ordering is invalid');
  }
  const message = { type: 'event' as const, ...event };
  assertProtocolMessageEnvelope(message);
  return message;
}
