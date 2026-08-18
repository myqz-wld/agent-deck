import { z } from 'zod';

import type { BrowserLeaseProof } from './browser-lease-registry-core';
import {
  BROWSER_OPERATION_NAMES,
  parseBrowserOperationRequest,
  type BrowserOperation,
  type BrowserOperationRequest,
} from './operation-contract';

export const BROWSER_CLI_MAX_REQUEST_BYTES = 128 * 1024;
export const BROWSER_CLI_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const proofSchema = z.object({
  adapterId: z.enum(['claude-code', 'codex-cli', 'grok-build']),
  runtimeGeneration: z.number().int().nonnegative(),
  sourceIdentity: z.string().min(1).max(512),
}).strict();

const wireSchema = z.object({
  protocolVersion: z.literal(1),
  lease: z.string().min(1).max(1_024),
  proof: proofSchema,
  request: z.unknown(),
}).strict();

export interface BrowserCliWireRequest {
  readonly lease: string;
  readonly proof: BrowserLeaseProof;
  readonly request: BrowserOperationRequest;
}

export function safeBrowserCliOperation(value: unknown): BrowserOperation {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const operation = (value as { operation?: unknown }).operation;
    if (
      typeof operation === 'string' &&
      BROWSER_OPERATION_NAMES.includes(operation as BrowserOperation)
    ) return operation as BrowserOperation;
  }
  return 'tabs';
}

export function parseBrowserCliWireEnvelope(value: unknown): {
  readonly lease: string;
  readonly proof: BrowserLeaseProof;
  readonly rawRequest: unknown;
} {
  const parsed = wireSchema.parse(value);
  return {
    lease: parsed.lease,
    proof: parsed.proof,
    rawRequest: parsed.request,
  };
}

export function parseBrowserCliWireRequest(value: unknown): BrowserCliWireRequest {
  const envelope = parseBrowserCliWireEnvelope(value);
  return {
    lease: envelope.lease,
    proof: envelope.proof,
    request: parseBrowserOperationRequest(envelope.rawRequest),
  };
}
