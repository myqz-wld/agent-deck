import {
  AgentDeckClientErrorCode,
  CORE_METHOD_METADATA,
  isJsonObject,
  type CoreMethod,
  type HostHello,
  type JsonObject,
} from '@contracts/index';
import type { ProtocolRequestMessage } from '@protocol/messages';

import { AgentDeckRemoteError, SshTransportError } from './errors';
import { isBoundedSingleLine, SSH_TEXT_LIMITS } from './limits';
import type { SshRequestOptions } from './types';

function requireNonEmpty(value: string | undefined, field: string): string | undefined {
  if (value !== undefined && !isBoundedSingleLine(value, SSH_TEXT_LIMITS.idempotencyKey)) {
    throw new SshTransportError(
      'invalid_request',
      `${field} must be free of wire control characters and at most ${SSH_TEXT_LIMITS.idempotencyKey} UTF-8 bytes`,
    );
  }
  return value;
}

function requireRevision(value: number | undefined, field: string): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new SshTransportError('invalid_request', `${field} must be a non-negative integer`);
  }
  return value;
}

export interface BuildRequestInput {
  method: CoreMethod;
  params: unknown;
  options: SshRequestOptions | undefined;
  requestId: string;
  generatedIdempotencyKey: string;
  now: number;
  hello: HostHello | null;
}

export function buildProtocolRequest(input: BuildRequestInput): ProtocolRequestMessage {
  const metadata = CORE_METHOD_METADATA[input.method];
  if (!metadata) {
    throw new SshTransportError('invalid_request', `Unknown Core method: ${input.method}`);
  }
  if (!isJsonObject(input.params)) {
    throw new SshTransportError('invalid_request', 'Request params must be a JSON object');
  }
  if (input.hello && !input.hello.capabilities.includes(metadata.capability)) {
    throw new AgentDeckRemoteError(
      AgentDeckClientErrorCode.CapabilityUnavailable,
      `Host does not advertise ${metadata.capability}`,
      false,
      undefined,
      { method: input.method, capability: metadata.capability },
    );
  }

  const requestedIdempotency = requireNonEmpty(input.options?.idempotencyKey, 'idempotencyKey');
  const requestedRevision = requireRevision(input.options?.expectedRevision, 'expectedRevision');
  if (metadata.idempotency === 'forbidden' && requestedIdempotency !== undefined) {
    throw new SshTransportError(
      'invalid_request',
      `${input.method} does not accept an idempotency key`,
    );
  }
  if (metadata.expectedRevision === 'none' && requestedRevision !== undefined) {
    throw new SshTransportError(
      'invalid_request',
      `${input.method} does not accept expectedRevision`,
    );
  }
  if (metadata.expectedRevision === 'required' && requestedRevision === undefined) {
    throw new SshTransportError(
      'invalid_request',
      `${input.method} requires expectedRevision`,
    );
  }

  const deadlineMs = input.options?.deadlineMs;
  if (deadlineMs !== undefined && (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0)) {
    throw new SshTransportError('invalid_request', 'deadlineMs must be a positive integer');
  }
  const deadlineAt = deadlineMs === undefined ? null : input.now + deadlineMs;
  if (
    deadlineAt !== null &&
    (!Number.isSafeInteger(input.now) || input.now < 0 || !Number.isSafeInteger(deadlineAt))
  ) {
    throw new SshTransportError('invalid_request', 'Request deadline is outside the safe range');
  }

  const idempotencyKey =
    metadata.idempotency === 'required'
      ? requireNonEmpty(
          requestedIdempotency ?? input.generatedIdempotencyKey,
          'idempotencyKey',
        ) ?? null
      : null;
  return {
    type: 'request',
    requestId: input.requestId,
    method: input.method,
    params: input.params as JsonObject,
    idempotencyKey,
    expectedRevision: requestedRevision ?? null,
    deadlineAt,
  };
}
