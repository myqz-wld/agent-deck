import {
  parseUsageProviderResult,
  parseUsageTokenResult,
} from '@contracts/index';
import type {
  RemoteHostUsageProviderDto,
  RemoteHostUsageProviderRequestDto,
  RemoteHostUsageTokenDto,
  RemoteHostUsageTokenRequestDto,
} from '@shared/remote-host';
import type { RemoteHostScopedRequest } from './service-detail-reader';
import { REMOTE_HOST_INTERACTIVE_DEADLINE_MS } from './service-scope';

export class RemoteHostUsageController {
  constructor(private readonly request: RemoteHostScopedRequest) {}

  tokens(request: RemoteHostUsageTokenRequestDto): Promise<RemoteHostUsageTokenDto> {
    return this.request(request.profileId, 'usage.tokens.get', async (scope) =>
      parseUsageTokenResult(await scope.client.request('usage.tokens.get', {
        includeDaily: request.includeDaily,
        dailyLimit: request.dailyLimit,
      }, { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS }), request.dailyLimit));
  }

  providers(request: RemoteHostUsageProviderRequestDto): Promise<RemoteHostUsageProviderDto> {
    return this.request(request.profileId, 'usage.providers.get', async (scope) =>
      parseUsageProviderResult(await scope.client.request(
        'usage.providers.get',
        { force: request.force },
        { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
      )));
  }
}
