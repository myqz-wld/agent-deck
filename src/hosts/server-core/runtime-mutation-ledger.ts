import { createHash } from 'node:crypto';

import { AgentDeckClientErrorCode, isJsonValue, type JsonValue } from '@contracts/index';
import { DaemonRequestError, type DaemonRequestInput, type DaemonRequestResult } from '@hosts/daemon';

import type { ServerCoreMutationClaim, ServerCoreMutationIdentity } from './runtime-metadata-store';
import { canonicalJson } from './runtime-validation';

export interface ServerCoreMutationLedgerPort {
  claimMutation(
    identity: ServerCoreMutationIdentity,
    now?: number,
    expectedRevision?: number,
  ): ServerCoreMutationClaim;
  completeMutation(identity: ServerCoreMutationIdentity, result: JsonValue, revision: number): void;
  releaseMutationClaim(identity: ServerCoreMutationIdentity): void;
}

export interface ClaimedServerCoreMutation {
  identity: ServerCoreMutationIdentity;
  replay: DaemonRequestResult | null;
}

export function claimServerCoreMutation(
  input: DaemonRequestInput,
  ledger: ServerCoreMutationLedgerPort,
): ClaimedServerCoreMutation {
  if (!input.idempotencyKey) {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.InvalidRequest,
      'Stable idempotency is required',
    );
  }
  const identity: ServerCoreMutationIdentity = {
    accessCredentialId: input.access.accessCredentialId,
    accessSurface: input.access.surface,
    idempotencyKey: input.idempotencyKey,
    method: input.method,
    requestFingerprint: createHash('sha256')
      .update(`${input.method}\u0000${canonicalJson(input.params)}`)
      .digest('hex'),
  };
  const claim = ledger.claimMutation(identity, Date.now(), input.expectedRevision ?? undefined);
  if (claim.state === 'claimed') return { identity, replay: null };
  if (claim.state === 'conflict') {
    throw new DaemonRequestError(AgentDeckClientErrorCode.Conflict, 'Mutation intent conflicts');
  }
  if (claim.state === 'uncertain') {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.ProviderLost,
      'The earlier mutation outcome is uncertain',
    );
  }
  if (!isJsonValue(claim.result)) throw new Error('Stored mutation result is invalid');
  return { identity, replay: { result: claim.result, revision: claim.revision } };
}

export function completeServerCoreMutation(
  claim: ClaimedServerCoreMutation,
  ledger: ServerCoreMutationLedgerPort,
  value: unknown,
  revision: number,
): DaemonRequestResult {
  if (!isJsonValue(value)) throw new Error('Mutation result is not JSON-safe');
  ledger.completeMutation(claim.identity, value, revision);
  return { result: value, revision };
}

export function releaseServerCoreMutation(
  claim: ClaimedServerCoreMutation,
  ledger: ServerCoreMutationLedgerPort,
  cause: unknown,
): never {
  try { ledger.releaseMutationClaim(claim.identity); }
  catch (releaseError) {
    throw new AggregateError([cause, releaseError], 'Mutation claim release failed');
  }
  throw cause;
}
