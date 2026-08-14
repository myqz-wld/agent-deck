import type {
  RemoteHostHistoryRequestDto,
  RemoteHostPageRequestDto,
} from './types';

export function remotePageRequest(
  profileId: string,
  limit: number,
  cursor?: string,
): RemoteHostPageRequestDto {
  return { profileId, limit, ...(cursor === undefined ? {} : { cursor }) };
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
