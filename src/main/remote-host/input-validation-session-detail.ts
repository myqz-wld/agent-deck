import {
  isJsonObject,
  parseSessionFileChangeGetParams,
  parseSessionFileChangeListParams,
  parseSessionFileFinalDiffParams,
  parseSessionImageAssetReadParams,
  parseSessionEventListParams,
  parseSessionSummaryListParams,
  parseSessionTaskListParams,
} from '@contracts/index';
import type {
  RemoteHostFileChangeGetRequestDto,
  RemoteHostFileChangePageRequestDto,
  RemoteHostFileFinalDiffRequestDto,
  RemoteHostImageAssetRequestDto,
  RemoteHostEventListRequestDto,
  RemoteHostSummaryRequestDto,
  RemoteHostTaskListRequestDto,
} from '@shared/remote-host';
import {
  parseRemoteHostProfileId,
  RemoteHostInputError,
} from './input-validation';

function exactObject(
  value: unknown,
  expected: readonly string[],
  field: string,
): Record<string, unknown> {
  if (!isJsonObject(value)) throw new RemoteHostInputError(field, 'must be an object');
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new RemoteHostInputError(field, 'contains unexpected fields');
  }
  return value;
}

export function parseRemoteHostSummaryRequest(value: unknown): RemoteHostSummaryRequestDto {
  const raw = exactObject(value, ['limit', 'profileId', 'sessionId'], 'summary');
  try {
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      ...parseSessionSummaryListParams({ sessionId: raw.sessionId, limit: raw.limit }),
    };
  } catch {
    throw new RemoteHostInputError('summary', 'invalid summary request');
  }
}

export function parseRemoteHostEventListRequest(value: unknown): RemoteHostEventListRequestDto {
  const raw = exactObject(value, ['limit', 'profileId', 'sessionId'], 'events');
  try {
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      ...parseSessionEventListParams({ sessionId: raw.sessionId, limit: raw.limit }),
    };
  } catch {
    throw new RemoteHostInputError('events', 'invalid event request');
  }
}

export function parseRemoteHostTaskListRequest(value: unknown): RemoteHostTaskListRequestDto {
  const raw = exactObject(value, ['limit', 'profileId', 'sessionId'], 'tasks');
  try {
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      ...parseSessionTaskListParams({ sessionId: raw.sessionId, limit: raw.limit }),
    };
  } catch {
    throw new RemoteHostInputError('tasks', 'invalid task request');
  }
}

export function parseRemoteHostFileChangePageRequest(
  value: unknown,
): RemoteHostFileChangePageRequestDto {
  if (!isJsonObject(value)) {
    throw new RemoteHostInputError('fileChanges', 'must be an object');
  }
  const expected = ['limit', 'profileId', 'sessionId'];
  if (value.cursor !== undefined) expected.push('cursor');
  const raw = exactObject(value, expected, 'fileChanges');
  try {
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      ...parseSessionFileChangeListParams({
        sessionId: raw.sessionId,
        ...(raw.cursor === undefined ? {} : { cursor: raw.cursor }),
        limit: raw.limit,
      }),
    };
  } catch {
    throw new RemoteHostInputError('fileChanges', 'invalid file-change request');
  }
}

export function parseRemoteHostFileChangeGetRequest(
  value: unknown,
): RemoteHostFileChangeGetRequestDto {
  const raw = exactObject(value, ['changeId', 'profileId', 'sessionId'], 'fileChange');
  try {
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      ...parseSessionFileChangeGetParams({
        sessionId: raw.sessionId,
        changeId: raw.changeId,
      }),
    };
  } catch {
    throw new RemoteHostInputError('fileChange', 'invalid file-change request');
  }
}

export function parseRemoteHostFileFinalDiffRequest(
  value: unknown,
): RemoteHostFileFinalDiffRequestDto {
  const raw = exactObject(value, ['filePath', 'profileId', 'sessionId'], 'fileFinalDiff');
  try {
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      ...parseSessionFileFinalDiffParams({
        sessionId: raw.sessionId,
        filePath: raw.filePath,
      }),
    };
  } catch {
    throw new RemoteHostInputError('fileFinalDiff', 'invalid final-diff request');
  }
}

export function parseRemoteHostImageAssetRequest(
  value: unknown,
): RemoteHostImageAssetRequestDto {
  const raw = exactObject(value, ['profileId', 'sessionId', 'source'], 'imageAsset');
  const source = exactObject(raw.source, ['changeId', 'kind', 'side'], 'imageAsset.source');
  if (source.kind !== 'remote-file-change') {
    throw new RemoteHostInputError('imageAsset.source', 'invalid image source');
  }
  try {
    const parsed = parseSessionImageAssetReadParams({
      sessionId: raw.sessionId,
      changeId: source.changeId,
      side: source.side,
      offset: 0,
    });
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      sessionId: parsed.sessionId,
      source: {
        kind: 'remote-file-change',
        changeId: parsed.changeId,
        side: parsed.side,
      },
    };
  } catch {
    throw new RemoteHostInputError('imageAsset', 'invalid image asset request');
  }
}
