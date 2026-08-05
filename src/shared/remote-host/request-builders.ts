import type {
  RemoteHostHistoryRequestDto,
  RemoteHostPageRequestDto,
  RemoteHostSessionPageRequestDto,
} from './types';

export function remotePageRequest(
  profileId: string,
  limit: number,
  cursor?: string,
): RemoteHostPageRequestDto {
  return { profileId, limit, ...(cursor === undefined ? {} : { cursor }) };
}

export function remoteSessionPageRequest(
  profileId: string,
  limit: number,
  input: { cursor?: string; includeArchived?: boolean } = {},
): RemoteHostSessionPageRequestDto {
  return {
    profileId,
    limit,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived }),
  };
}

export function remoteHistoryRequest(
  profileId: string,
  sessionId: string,
  limit: number,
  cursor?: string,
): RemoteHostHistoryRequestDto {
  return {
    profileId,
    sessionId,
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  };
}
