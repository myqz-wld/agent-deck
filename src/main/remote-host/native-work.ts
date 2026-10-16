import { isJsonObject, parseNativeWorkListParams, parseNativeWorkDetailParams, parseNativeWorkStopParams,
  parseNativeWorkListResult, parseNativeWorkDetailResult, parseNativeWorkStopResult } from '@contracts/index';
import type { RemoteNativeWorkListRequest, RemoteNativeWorkDetailRequest, RemoteNativeWorkStopRequest } from '@shared/remote-host/native-work';
import { parseRemoteHostProfileId, parseRemoteHostMutationTarget, RemoteHostInputError } from './input-validation';
import type { RemoteHostScopedRequest } from './service-scope';

export function parseRemoteNativeWorkList(value: unknown): RemoteNativeWorkListRequest {
  if (!isJsonObject(value)) throw new RemoteHostInputError('native-work', 'must be an object');
  const { profileId, ...params } = value;
  return { profileId: parseRemoteHostProfileId(profileId), ...parseNativeWorkListParams(params) };
}
export function parseRemoteNativeWorkDetail(value: unknown): RemoteNativeWorkDetailRequest {
  if (!isJsonObject(value)) throw new RemoteHostInputError('native-work', 'must be an object');
  const { profileId, ...params } = value;
  return { profileId: parseRemoteHostProfileId(profileId), ...parseNativeWorkDetailParams(params) };
}
export function parseRemoteNativeWorkStop(value: unknown): RemoteNativeWorkStopRequest {
  if (!isJsonObject(value)) throw new RemoteHostInputError('native-work', 'must be an object');
  const { ref, ...target } = value;
  const parsed = parseNativeWorkStopParams({ ref });
  const mutation = parseRemoteHostMutationTarget({ ...target, sessionId: parsed.ref.sessionId });
  return { profileId: mutation.profileId, ref: parsed.ref, intentId: mutation.intentId, expectedAuthority: mutation.expectedAuthority };
}

export class RemoteNativeWorkController {
  constructor(private readonly request: RemoteHostScopedRequest,
    private readonly mutationId: (operation: string, profileId: string, intentId: string) => string) {}
  list(input: RemoteNativeWorkListRequest) {
    const { profileId, ...params } = input;
    return this.request(profileId, 'session.native-work.list', async scope => parseNativeWorkListResult(
      await scope.client.request('session.native-work.list', params, { deadlineMs: 45000 }), params.sessionId));
  }
  details(input: RemoteNativeWorkDetailRequest) {
    const { profileId, ...params } = input;
    return this.request(profileId, 'session.native-work.details', async scope => parseNativeWorkDetailResult(
      await scope.client.request('session.native-work.details', params, { deadlineMs: 45000 }), params.ref));
  }
  stop(input: RemoteNativeWorkStopRequest) {
    return this.request(input.profileId, 'session.native-work.stop', async scope => parseNativeWorkStopResult(
      await scope.client.request('session.native-work.stop', { ref: input.ref }, { deadlineMs: 45000,
        idempotencyKey: this.mutationId('native-work-stop', input.profileId, input.intentId) })), [], input.expectedAuthority);
  }
}
