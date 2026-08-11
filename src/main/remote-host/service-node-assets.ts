import {
  parseNodeAssetContentResult,
  parseNodeAssetConventionResult,
  parseNodeAssetListResult,
} from '@contracts/index';
import type {
  RemoteHostNodeAssetContentDto,
  RemoteHostNodeAssetContentRequestDto,
  RemoteHostNodeAssetConventionDto,
  RemoteHostNodeAssetConventionRequestDto,
  RemoteHostNodeAssetListDto,
  RemoteHostNodeAssetListRequestDto,
} from '@shared/remote-host';

import type { RemoteHostScopedRequest } from './service-detail-reader';
import { REMOTE_HOST_INTERACTIVE_DEADLINE_MS } from './service-scope';

/** Source-fenced reads over the selected Worker/Core asset catalog. */
export class RemoteHostNodeAssetController {
  constructor(private readonly request: RemoteHostScopedRequest) {}

  list(request: RemoteHostNodeAssetListRequestDto): Promise<RemoteHostNodeAssetListDto> {
    return this.request(request.profileId, 'node.assets.list', async (scope) =>
      parseNodeAssetListResult(await scope.client.request(
        'node.assets.list',
        {},
        { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
      )));
  }

  content(
    request: RemoteHostNodeAssetContentRequestDto,
  ): Promise<RemoteHostNodeAssetContentDto> {
    return this.request(request.profileId, 'node.assets.content', async (scope) =>
      parseNodeAssetContentResult(await scope.client.request(
        'node.assets.content',
        {
          adapterId: request.adapterId,
          kind: request.kind,
          source: request.source,
          name: request.name,
          qualifiedName: request.qualifiedName,
          location: request.location,
        },
        { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
      )));
  }

  convention(
    request: RemoteHostNodeAssetConventionRequestDto,
  ): Promise<RemoteHostNodeAssetConventionDto> {
    return this.request(request.profileId, 'node.assets.convention', async (scope) =>
      parseNodeAssetConventionResult(await scope.client.request(
        'node.assets.convention',
        { adapterId: request.adapterId },
        { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
      )));
  }
}
