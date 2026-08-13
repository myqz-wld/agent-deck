import {
  parseNodeConfigurationGetResult,
  parseNodeHookProjectionResult,
} from '@contracts/index';
import type {
  RemoteHostNodeConfigurationDto,
  RemoteHostNodeConfigurationRequestDto,
  RemoteHostNodeHookRequestDto,
  RemoteHostNodeHookStatusDto,
} from '@shared/remote-host';

import type { RemoteHostScopedRequest } from './service-detail-reader';
import { RemoteHostPublicError } from './errors';
import { REMOTE_HOST_INTERACTIVE_DEADLINE_MS } from './service-scope';

/** Reads only the selected Remote Core's Worker-owned configuration snapshots. */
export class RemoteHostNodeConfigurationController {
  constructor(private readonly request: RemoteHostScopedRequest) {}

  get(
    request: RemoteHostNodeConfigurationRequestDto,
  ): Promise<RemoteHostNodeConfigurationDto> {
    return this.request(request.profileId, 'node.configuration.get', async (scope) =>
      parseNodeConfigurationGetResult(await scope.client.request(
        'node.configuration.get',
        {},
        { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
      )));
  }

  status(request: RemoteHostNodeHookRequestDto): Promise<RemoteHostNodeHookStatusDto> {
    return this.request(request.profileId, 'node.hook.projection.get', async (scope) =>
      this.assertAdapter(request.adapterId, parseNodeHookProjectionResult(await scope.client.request(
        'node.hook.projection.get',
        { adapterId: request.adapterId },
        { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
      ))));
  }

  private assertAdapter(
    expected: RemoteHostNodeHookRequestDto['adapterId'],
    result: RemoteHostNodeHookStatusDto,
  ): RemoteHostNodeHookStatusDto {
    if (result.adapterId !== expected) {
      throw new RemoteHostPublicError(
        'protocol_violation',
        '远程 Hook 状态与请求的 Provider 不一致。',
      );
    }
    return result;
  }
}
