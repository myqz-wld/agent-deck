import {
  parseSessionFileChangeGetResult,
  parseSessionFileChangeListResult,
  parseSessionFileFinalDiffResult,
  parseSessionImageAssetReadResult,
  parseSessionEventListResult,
  parseSessionSummaryListResult,
  parseSessionTaskListResult,
  SESSION_IMAGE_ASSET_CHUNK_BYTES,
  SESSION_IMAGE_ASSET_MAX_BYTES,
} from '@contracts/index';
import type {
  RemoteHostFileChangeGetDto,
  RemoteHostFileChangeGetRequestDto,
  RemoteHostFileChangePageDto,
  RemoteHostFileChangePageRequestDto,
  RemoteHostFileFinalDiffDto,
  RemoteHostFileFinalDiffRequestDto,
  RemoteHostImageAssetRequestDto,
  RemoteHostImageAssetResultDto,
  RemoteHostEventListDto,
  RemoteHostEventListRequestDto,
  RemoteHostHistoryPageDto,
  RemoteHostHistoryRequestDto,
  RemoteHostPendingListDto,
  RemoteHostRuntimeControlsDto,
  RemoteHostSessionTargetDto,
  RemoteHostSummaryListDto,
  RemoteHostSummaryRequestDto,
  RemoteHostTaskListDto,
  RemoteHostTaskListRequestDto,
} from '@shared/remote-host';
import {
  parseRemoteHostHistoryPageResult,
  parseRemoteHostPendingListResult,
  parseRemoteHostRuntimeControlsResult,
} from './business-validation';
import {
  REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
  type RemoteHostScopedClient,
} from './service-scope';

export async function requestRemoteHistory(
  scope: RemoteHostScopedClient,
  request: RemoteHostHistoryRequestDto,
): Promise<RemoteHostHistoryPageDto> {
  const value = await scope.client.request('session.history', {
    sessionId: request.sessionId,
    ...(request.cursor ? { cursor: request.cursor } : {}),
    limit: request.limit,
  }, { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS });
  return parseRemoteHostHistoryPageResult(value, request.limit, request.sessionId);
}

export async function requestRemoteEvents(
  scope: RemoteHostScopedClient,
  request: RemoteHostEventListRequestDto,
): Promise<RemoteHostEventListDto> {
  const value = await scope.client.request('session.events.list', {
    sessionId: request.sessionId,
    limit: request.limit,
  }, { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS });
  return parseSessionEventListResult(value, request.sessionId, request.limit);
}

export async function requestRemoteSummaries(
  scope: RemoteHostScopedClient,
  request: RemoteHostSummaryRequestDto,
): Promise<RemoteHostSummaryListDto> {
  const value = await scope.client.request('session.summaries.list', {
    sessionId: request.sessionId,
    limit: request.limit,
  }, { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS });
  return parseSessionSummaryListResult(value, request.sessionId, request.limit);
}

export async function requestRemoteTasks(
  scope: RemoteHostScopedClient,
  request: RemoteHostTaskListRequestDto,
): Promise<RemoteHostTaskListDto> {
  const value = await scope.client.request('session.tasks.list', {
    sessionId: request.sessionId,
    limit: request.limit,
  }, { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS });
  return parseSessionTaskListResult(value, request.limit);
}

export async function requestRemoteFileChanges(
  scope: RemoteHostScopedClient,
  request: RemoteHostFileChangePageRequestDto,
): Promise<RemoteHostFileChangePageDto> {
  const value = await scope.client.request('session.file-changes.list', {
    sessionId: request.sessionId,
    ...(request.cursor ? { cursor: request.cursor } : {}),
    limit: request.limit,
  }, { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS });
  return parseSessionFileChangeListResult(value, request.sessionId, request.limit);
}

export async function requestRemoteFileChange(
  scope: RemoteHostScopedClient,
  request: RemoteHostFileChangeGetRequestDto,
): Promise<RemoteHostFileChangeGetDto> {
  const value = await scope.client.request('session.file-changes.get', {
    sessionId: request.sessionId,
    changeId: request.changeId,
  }, { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS });
  return parseSessionFileChangeGetResult(value, request.sessionId, request.changeId);
}

export async function requestRemoteFileFinalDiff(
  scope: RemoteHostScopedClient,
  request: RemoteHostFileFinalDiffRequestDto,
): Promise<RemoteHostFileFinalDiffDto> {
  const value = await scope.client.request('session.file-changes.final-diff', {
    sessionId: request.sessionId,
    filePath: request.filePath,
  }, { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS });
  return parseSessionFileFinalDiffResult(value, request.filePath);
}

export async function requestRemoteImageAsset(
  scope: RemoteHostScopedClient,
  request: RemoteHostImageAssetRequestDto,
): Promise<RemoteHostImageAssetResultDto> {
  const chunks: Buffer[] = [];
  let offset = 0;
  let assetId: string | undefined;
  let mime: string | undefined;
  let totalBytes: number | undefined;
  const maximumChunks = Math.ceil(
    SESSION_IMAGE_ASSET_MAX_BYTES / SESSION_IMAGE_ASSET_CHUNK_BYTES,
  );
  for (let index = 0; index < maximumChunks; index += 1) {
    const value = await scope.client.request('session.assets.image-chunk.read', {
      sessionId: request.sessionId,
      changeId: request.source.changeId,
      side: request.source.side,
      offset,
      ...(assetId ? { expectedAssetId: assetId } : {}),
    }, { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS });
    const parsed = parseSessionImageAssetReadResult(value, {
      sessionId: request.sessionId,
      changeId: request.source.changeId,
      side: request.source.side,
    });
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    if (parsed.offset !== offset) return { ok: false, reason: 'changed' };
    if (assetId && (
      parsed.assetId !== assetId || parsed.mime !== mime || parsed.totalBytes !== totalBytes
    )) return { ok: false, reason: 'changed' };
    assetId = parsed.assetId;
    mime = parsed.mime;
    totalBytes = parsed.totalBytes;
    chunks.push(Buffer.from(parsed.base64, 'base64'));
    if (parsed.nextOffset === null) {
      const bytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      if (bytes !== totalBytes) return { ok: false, reason: 'changed' };
      return {
        ok: true,
        mime,
        bytes,
        dataUrl: `data:${mime};base64,${Buffer.concat(chunks, bytes).toString('base64')}`,
      };
    }
    offset = parsed.nextOffset;
  }
  return { ok: false, reason: 'too_big' };
}

export async function requestRemotePending(
  scope: RemoteHostScopedClient,
  request: RemoteHostSessionTargetDto,
): Promise<RemoteHostPendingListDto> {
  const value = await scope.client.request(
    'pending.list',
    { sessionId: request.sessionId },
    { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
  );
  return parseRemoteHostPendingListResult(value, request.sessionId);
}

export async function requestRemoteRuntime(
  scope: RemoteHostScopedClient,
  request: RemoteHostSessionTargetDto,
): Promise<RemoteHostRuntimeControlsDto> {
  const value = await scope.client.request(
    'session.runtime.get',
    { sessionId: request.sessionId },
    { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
  );
  return parseRemoteHostRuntimeControlsResult(value);
}
