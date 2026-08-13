import {
  parsePendingIndexListResult,
  parseSessionPresentationListResult,
} from '@contracts/index';
import type {
  RemoteHostPendingIndexDto,
  RemoteHostPendingIndexRequestDto,
  RemoteHostSessionPresentationPageDto,
  RemoteHostSessionPresentationRequestDto,
} from '@shared/remote-host';

import { parseRemoteHostPendingListResult } from './business-validation';
import {
  REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
  type RemoteHostScopedRequest,
} from './service-scope';

/** Main-process source fence and second parser for the typed Remote list surfaces. */
export class RemoteHostSessionPresentationController {
  constructor(private readonly request: RemoteHostScopedRequest) {}

  list(
    request: RemoteHostSessionPresentationRequestDto,
  ): Promise<RemoteHostSessionPresentationPageDto> {
    return this.request(request.profileId, 'session.presentation.list', async (scope) => {
      const value = await scope.client.request(
        'session.presentation.list',
        {
          kind: request.kind,
          limit: request.limit,
          ...(request.archivedOnly === undefined ? {} : { archivedOnly: request.archivedOnly }),
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          ...(request.query === undefined ? {} : { query: request.query }),
        },
        { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
      );
      return parseSessionPresentationListResult(value, request.limit);
    });
  }

  pending(request: RemoteHostPendingIndexRequestDto): Promise<RemoteHostPendingIndexDto> {
    return this.request(request.profileId, 'pending.index.list', async (scope) => {
      const value = parsePendingIndexListResult(await scope.client.request(
        'pending.index.list',
        {
          limit: request.limit,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        },
        { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
      ), request.limit);
      return {
        buckets: value.buckets.map((bucket) => ({
          session: bucket.session,
          pending: parseRemoteHostPendingListResult({
            requests: bucket.requests,
            revision: bucket.revision,
          }, bucket.session.id),
        })),
        nextCursor: value.nextCursor,
        totalBuckets: value.totalBuckets,
        totalRequests: value.totalRequests,
        scanTruncated: value.scanTruncated,
        revision: value.revision,
      };
    });
  }
}
