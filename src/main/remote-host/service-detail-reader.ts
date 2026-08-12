import type { CoreMethod } from '@contracts/index';
import type {
  RemoteHostFileChangeGetDto,
  RemoteHostFileChangeGetRequestDto,
  RemoteHostFileChangePageDto,
  RemoteHostFileChangePageRequestDto,
  RemoteHostFileFinalDiffDto,
  RemoteHostFileFinalDiffRequestDto,
  RemoteHostImageAssetRequestDto,
  RemoteHostImageAssetResultDto,
  RemoteHostMutationAuthorityDto,
  RemoteHostEventListDto,
  RemoteHostEventListRequestDto,
  RemoteHostSummaryListDto,
  RemoteHostSummaryRequestDto,
  RemoteHostTaskListDto,
  RemoteHostTaskListRequestDto,
} from '@shared/remote-host';
import {
  requestRemoteFileChange,
  requestRemoteFileChanges,
  requestRemoteFileFinalDiff,
  requestRemoteImageAsset,
  requestRemoteEvents,
  requestRemoteSummaries,
  requestRemoteTasks,
} from './service-session-detail';
import type { RemoteHostScopedClient } from './service-scope';

export type RemoteHostScopedRequest = <T>(
  profileId: string,
  method: CoreMethod,
  run: (scope: RemoteHostScopedClient) => Promise<T>,
  additionalMethods?: readonly CoreMethod[],
  expectedAuthority?: RemoteHostMutationAuthorityDto,
) => Promise<T>;

/** Read-only SessionDetail surfaces sharing the service's capability and epoch fences. */
export class RemoteHostDetailReader {
  constructor(private readonly request: RemoteHostScopedRequest) {}

  listEvents(request: RemoteHostEventListRequestDto): Promise<RemoteHostEventListDto> {
    return this.request(request.profileId, 'session.events.list', (scope) =>
      requestRemoteEvents(scope, request));
  }

  listSummaries(request: RemoteHostSummaryRequestDto): Promise<RemoteHostSummaryListDto> {
    return this.request(request.profileId, 'session.summaries.list', (scope) =>
      requestRemoteSummaries(scope, request));
  }

  listTasks(request: RemoteHostTaskListRequestDto): Promise<RemoteHostTaskListDto> {
    return this.request(request.profileId, 'session.tasks.list', (scope) =>
      requestRemoteTasks(scope, request));
  }

  listFileChanges(
    request: RemoteHostFileChangePageRequestDto,
  ): Promise<RemoteHostFileChangePageDto> {
    return this.request(request.profileId, 'session.file-changes.list', (scope) =>
      requestRemoteFileChanges(scope, request));
  }

  getFileChange(request: RemoteHostFileChangeGetRequestDto): Promise<RemoteHostFileChangeGetDto> {
    return this.request(request.profileId, 'session.file-changes.get', (scope) =>
      requestRemoteFileChange(scope, request));
  }

  getFileFinalDiff(
    request: RemoteHostFileFinalDiffRequestDto,
  ): Promise<RemoteHostFileFinalDiffDto> {
    return this.request(request.profileId, 'session.file-changes.final-diff', (scope) =>
      requestRemoteFileFinalDiff(scope, request));
  }

  loadImageAsset(request: RemoteHostImageAssetRequestDto): Promise<RemoteHostImageAssetResultDto> {
    return this.request(request.profileId, 'session.assets.image-chunk.read', (scope) =>
      requestRemoteImageAsset(scope, request));
  }
}
