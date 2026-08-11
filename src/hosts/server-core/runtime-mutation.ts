import {
  AgentDeckClientErrorCode,
  isJsonValue,
} from '@contracts/index';
import {
  DaemonRequestError,
  type DaemonRequestResult,
} from '@hosts/daemon';

import type { ServerCoreMutationClaim } from './runtime-metadata-store';

export function serverCoreMutationReplay(
  claim: ServerCoreMutationClaim,
): DaemonRequestResult | null {
  if (claim.state === 'claimed') return null;
  if (claim.state === 'conflict') {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.Conflict,
      'Mutation revision or idempotency does not match',
    );
  }
  if (claim.state === 'uncertain') {
    throw new DaemonRequestError(
      AgentDeckClientErrorCode.ProviderLost,
      'The earlier mutation outcome is uncertain',
    );
  }
  if (!isJsonValue(claim.result)) throw new Error('Stored mutation result is invalid');
  return { result: claim.result, revision: claim.revision };
}
