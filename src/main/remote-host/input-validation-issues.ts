import {
  isJsonObject,
  parseIssueGetParams,
  parseIssueListParams,
  parseIssueResolveInNewSessionParams,
  parseIssueUpdateParams,
} from '@contracts/index';
import type {
  RemoteHostIssueListRequestDto,
  RemoteHostIssueMutationTargetDto,
  RemoteHostIssueResolveSessionDto,
  RemoteHostIssueTargetDto,
  RemoteHostIssueUpdateDto,
} from '@shared/remote-host';
import {
  RemoteHostInputError,
  parseRemoteHostMutationAuthority,
  parseRemoteHostCreateSession,
  parseRemoteHostProfileId,
} from './input-validation';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

function object(value: unknown, field: string): Record<string, unknown> {
  if (!isJsonObject(value)) throw new RemoteHostInputError(field, 'must be an object');
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new RemoteHostInputError(field, 'contains unexpected fields');
  }
}

function intent(value: unknown): string {
  if (
    typeof value !== 'string' || !TOKEN.test(value) ||
    Buffer.byteLength(value, 'utf8') > 256
  ) throw new RemoteHostInputError('intentId', 'must be a bounded token');
  return value;
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RemoteHostInputError('expectedRevision', 'must be a non-negative integer');
  }
  return value as number;
}

export function parseRemoteHostIssueListRequest(value: unknown): RemoteHostIssueListRequestDto {
  const raw = object(value, 'issues');
  exactKeys(raw, [
    'includeDeleted', 'kinds', 'limit', 'offset', 'profileId', 'statuses', 'titleKeyword',
  ], 'issues');
  try {
    const parsed = parseIssueListParams({
      statuses: raw.statuses,
      kinds: raw.kinds,
      titleKeyword: raw.titleKeyword,
      includeDeleted: raw.includeDeleted,
      limit: raw.limit,
      offset: raw.offset,
    });
    return { profileId: parseRemoteHostProfileId(raw.profileId), ...parsed };
  } catch {
    throw new RemoteHostInputError('issues', 'invalid issue list request');
  }
}

export function parseRemoteHostIssueTarget(value: unknown): RemoteHostIssueTargetDto {
  const raw = object(value, 'issue');
  exactKeys(raw, ['issueId', 'profileId'], 'issue');
  try {
    const parsed = parseIssueGetParams({ issueId: raw.issueId });
    return { profileId: parseRemoteHostProfileId(raw.profileId), issueId: parsed.issueId };
  } catch {
    throw new RemoteHostInputError('issue', 'invalid issue request');
  }
}

export function parseRemoteHostIssueMutationTarget(
  value: unknown,
): RemoteHostIssueMutationTargetDto {
  const raw = object(value, 'issue');
  exactKeys(raw, [
    'expectedAuthority', 'expectedRevision', 'intentId', 'issueId', 'profileId',
  ], 'issue');
  try {
    const parsed = parseIssueGetParams({ issueId: raw.issueId });
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      issueId: parsed.issueId,
      expectedAuthority: parseRemoteHostMutationAuthority(raw.expectedAuthority),
      intentId: intent(raw.intentId),
      expectedRevision: revision(raw.expectedRevision),
    };
  } catch {
    throw new RemoteHostInputError('issue', 'invalid issue mutation request');
  }
}

export function parseRemoteHostIssueUpdate(value: unknown): RemoteHostIssueUpdateDto {
  const raw = object(value, 'issue');
  exactKeys(raw, [
    'expectedAuthority', 'expectedRevision', 'intentId', 'issueId', 'patch', 'profileId',
  ], 'issue');
  try {
    const parsed = parseIssueUpdateParams({ issueId: raw.issueId, patch: raw.patch });
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      issueId: parsed.issueId,
      patch: parsed.patch,
      expectedAuthority: parseRemoteHostMutationAuthority(raw.expectedAuthority),
      intentId: intent(raw.intentId),
      expectedRevision: revision(raw.expectedRevision),
    };
  } catch {
    throw new RemoteHostInputError('issue', 'invalid issue update request');
  }
}

export function parseRemoteHostIssueResolveSession(
  value: unknown,
): RemoteHostIssueResolveSessionDto {
  const raw = object(value, 'issueResolution');
  exactKeys(raw, [
    'adapterId', 'attachments', 'capabilityRevision', 'expectedRevision', 'initialMessage',
    'expectedAuthority', 'intentId', 'issueId', 'issueUpdatedAt', 'options', 'profileId',
    'projectTrust',
    'workingDirectory',
  ], 'issueResolution');
  try {
    const create = parseRemoteHostCreateSession({
      profileId: raw.profileId,
      adapterId: raw.adapterId,
      attachments: raw.attachments,
      capabilityRevision: raw.capabilityRevision,
      expectedAuthority: raw.expectedAuthority,
      initialMessage: raw.initialMessage,
      intentId: raw.intentId,
      options: raw.options,
      projectTrust: raw.projectTrust,
      workingDirectory: raw.workingDirectory,
    });
    const parsed = parseIssueResolveInNewSessionParams({
      issueId: raw.issueId,
      issueUpdatedAt: raw.issueUpdatedAt,
      create: {
        adapterId: create.adapterId,
        attachments: create.attachments,
        capabilityRevision: create.capabilityRevision,
        initialMessage: create.initialMessage,
        projectTrust: create.projectTrust,
        options: create.options,
        workingDirectory: create.workingDirectory,
      },
    });
    return {
      ...create,
      issueId: parsed.issueId,
      issueUpdatedAt: parsed.issueUpdatedAt,
      expectedRevision: revision(raw.expectedRevision),
    };
  } catch (error) {
    if (error instanceof RemoteHostInputError) throw error;
    throw new RemoteHostInputError('issueResolution', 'invalid issue resolution request');
  }
}
