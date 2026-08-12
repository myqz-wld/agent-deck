import type {
  IssueDto,
  IssueGetResult,
  IssueListResult,
  IssueMutationResult,
  IssueResolveInNewSessionResult,
  IssueStatusDto,
  IssueUpdatePatchDto,
  SessionFileChangeGetResult,
  SessionFileChangeListResult,
  SessionFileFinalDiffResult,
  SessionEventListResult,
  SessionConsoleAttachmentInput,
  SessionConsoleCapabilitiesResult,
  SessionConsoleCreateOptions,
  SessionSummaryListResult,
  SessionTaskListResult,
  TeamAddMemberResult,
  TeamGetResult,
  TeamListResult,
  TeamMemberRoleDto,
  TeamMutationResult,
  TeamShutdownResult,
  UsageProviderResult,
  UsageTokenResult,
  WorkspaceDirectoryListResult,
  NodeConfigurationGetResult,
  NodeConfigurationAdapterId,
  NodeHookProjectionResult,
  NodeAssetAdapterId,
  NodeAssetContentResult,
  NodeAssetConventionResult,
  NodeAssetKind,
  NodeAssetListResult,
  NodeAssetSource,
  SessionPresentationListResult,
  SessionPresentationKind,
  SessionPresentationSummaryDto,
} from '@contracts/index';
import type { LoadImageBlobResult } from '@shared/types';
import type {
  RemoteHostMutationIntentDto,
  RemoteHostSessionTargetDto,
} from './session-request-types';

export * from './session-request-types';

export type RemoteHostTopology = 'standalone' | 'server-core' | 'relay';
export type RemoteHostRemoteTopology = Exclude<RemoteHostTopology, 'standalone'>;
export type RemoteHostSourceMode = 'local' | 'remote';

export type RemoteHostConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'incompatible'
  | 'offline';

export type RemoteHostJsonPrimitive = boolean | number | string | null;
export type RemoteHostJsonValue =
  | RemoteHostJsonPrimitive
  | RemoteHostJsonValue[]
  | { [key: string]: RemoteHostJsonValue };
export type RemoteHostJsonObject = { [key: string]: RemoteHostJsonValue };

export interface RemoteHostNodeAssetListRequestDto { profileId: string }
export interface RemoteHostNodeAssetContentRequestDto {
  profileId: string;
  adapterId: NodeAssetAdapterId;
  kind: NodeAssetKind;
  source: NodeAssetSource;
  name: string;
  qualifiedName: string;
  location: string;
}
export interface RemoteHostNodeAssetConventionRequestDto {
  profileId: string;
  adapterId: NodeAssetAdapterId;
}
export type RemoteHostNodeAssetListDto = NodeAssetListResult;
export type RemoteHostNodeAssetContentDto = NodeAssetContentResult;
export type RemoteHostNodeAssetConventionDto = NodeAssetConventionResult;

export interface RemoteHostEndpointDto {
  hostname: string;
  port: number;
  username: string;
  hostKeyFingerprint: string | null;
}

export interface RemoteHostProfileDto {
  id: string;
  label: string;
  scope: 'local' | 'remote';
  endpoint: RemoteHostEndpointDto | null;
  credentials: {
    connectionCredentialConfigured: boolean;
  };
}

export interface RemoteHostStateDto {
  profileId: string;
  status: RemoteHostConnectionStatus;
  recovery: 'worker-offline' | null;
  authoritativeCoreId: string | null;
  workerGeneration: number | null;
  capabilities: string[];
  eventRevision: number;
  error: { code: string; message: string } | null;
}

export interface RemoteHostSnapshotDto {
  revision: number;
  sourceMode: RemoteHostSourceMode;
  selectedRemoteProfileId: string | null;
  profiles: RemoteHostProfileDto[];
  states: RemoteHostStateDto[];
}

export interface RemoteHostProfileDraftDto {
  label: string;
  connectionSelectionId: string | null;
}

export interface RemoteHostConnectionSelectionDto {
  selectionId: string;
  label: string;
  endpoint: RemoteHostEndpointDto;
}

export interface RemoteHostPageRequestDto {
  profileId: string;
  cursor?: string;
  limit: number;
}

export interface RemoteHostSessionPageRequestDto extends RemoteHostPageRequestDto {
  includeArchived?: boolean;
}

export interface RemoteHostSessionSummaryDto {
  id: string;
  adapterId: string;
  title: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface RemoteHostSessionPageDto {
  sessions: RemoteHostSessionSummaryDto[];
  nextCursor: string | null;
  total: number | null;
  revision: number;
}

export interface RemoteHostSessionPresentationRequestDto {
  profileId: string;
  kind: SessionPresentationKind;
  cursor?: string;
  limit: number;
  query?: string;
}

export type RemoteHostSessionPresentationDto = SessionPresentationSummaryDto;
export type RemoteHostSessionPresentationPageDto = SessionPresentationListResult;

export interface RemoteHostPendingIndexRequestDto {
  profileId: string;
  cursor?: string;
  limit: number;
}

export interface RemoteHostPendingIndexBucketDto {
  session: RemoteHostSessionPresentationDto;
  pending: RemoteHostPendingListDto;
}

export interface RemoteHostPendingIndexDto {
  buckets: RemoteHostPendingIndexBucketDto[];
  nextCursor: string | null;
  totalBuckets: number;
  totalRequests: number;
  scanTruncated: boolean;
  revision: number;
}

export interface RemoteHostProjectDto {
  projectId: string;
  projectRef: string;
  alias: string;
  title: string | null;
}

export interface RemoteHostProjectPageDto {
  projects: RemoteHostProjectDto[];
  nextCursor: string | null;
  total: number | null;
  revision: number;
}

export interface RemoteHostSessionCapabilitiesRequestDto {
  profileId: string;
  adapterId: string | null;
  provider: string;
  workingDirectory: string;
}

export type RemoteHostSessionCapabilitiesDto = SessionConsoleCapabilitiesResult;

export interface RemoteHostWorkspaceDirectoryRequestDto {
  profileId: string;
  directory: string;
}

export type RemoteHostWorkspaceDirectoryListDto = WorkspaceDirectoryListResult;

export interface RemoteHostCreateSessionDto extends RemoteHostMutationIntentDto {
  profileId: string;
  adapterId: string;
  attachments: SessionConsoleAttachmentInput[];
  capabilityRevision: string;
  initialMessage: string;
  workingDirectory: string;
  options: SessionConsoleCreateOptions;
}

export interface RemoteHostHistoryRequestDto {
  profileId: string;
  sessionId: string;
  cursor?: string;
  limit: number;
}

export interface RemoteHostHistoryEntryDto {
  id: string;
  sessionId: string;
  sequence: number;
  role: 'assistant' | 'system' | 'user';
  content: RemoteHostJsonValue;
  createdAt: number;
}

export interface RemoteHostHistoryPageDto {
  entries: RemoteHostHistoryEntryDto[];
  nextCursor: string | null;
  revision: number;
}

export interface RemoteHostSummaryRequestDto extends RemoteHostSessionTargetDto {
  limit: number;
}

export type RemoteHostSummaryListDto = SessionSummaryListResult;

export interface RemoteHostEventListRequestDto extends RemoteHostSessionTargetDto {
  limit: number;
}

export type RemoteHostEventListDto = SessionEventListResult;

export interface RemoteHostTaskListRequestDto extends RemoteHostSessionTargetDto {
  limit: number;
}

export type RemoteHostTaskListDto = SessionTaskListResult;

export interface RemoteHostTeamListRequestDto {
  profileId: string;
  includeArchived: boolean;
  limit: number;
}

export interface RemoteHostTeamTargetDto {
  profileId: string;
  teamId: string;
}

export interface RemoteHostTeamMutationTargetDto
  extends RemoteHostTeamTargetDto, RemoteHostMutationIntentDto {
  expectedRevision: number;
}

export interface RemoteHostTeamAddMemberDto extends RemoteHostTeamMutationTargetDto {
  sessionId: string;
  role: TeamMemberRoleDto;
}

export type RemoteHostTeamListDto = TeamListResult;
export type RemoteHostTeamGetDto = TeamGetResult;
export type RemoteHostTeamMutationResultDto = TeamMutationResult;
export type RemoteHostTeamAddMemberResultDto = TeamAddMemberResult;
export type RemoteHostTeamShutdownResultDto = TeamShutdownResult;

export interface RemoteHostUsageTokenRequestDto {
  profileId: string;
  includeDaily: boolean;
  dailyLimit: number;
}

export interface RemoteHostUsageProviderRequestDto {
  profileId: string;
  force: boolean;
}

export type RemoteHostUsageTokenDto = UsageTokenResult;
export type RemoteHostUsageProviderDto = UsageProviderResult;

export interface RemoteHostNodeConfigurationRequestDto {
  profileId: string;
}

export interface RemoteHostNodeHookRequestDto extends RemoteHostNodeConfigurationRequestDto {
  adapterId: NodeConfigurationAdapterId;
}

export interface RemoteHostNodeHookMutationDto
  extends RemoteHostNodeHookRequestDto, RemoteHostMutationIntentDto {}

export type RemoteHostNodeConfigurationDto = NodeConfigurationGetResult;
export type RemoteHostNodeHookStatusDto = NodeHookProjectionResult;

export interface RemoteHostIssueListRequestDto {
  profileId: string;
  statuses: IssueStatusDto[];
  kinds: string[];
  titleKeyword: string | null;
  includeDeleted: boolean;
  limit: number;
  offset: number;
}

export type RemoteHostIssueDto = IssueDto;
export type RemoteHostIssueListDto = IssueListResult;
export type RemoteHostIssueGetDto = IssueGetResult;

export interface RemoteHostIssueTargetDto {
  profileId: string;
  issueId: string;
}

export interface RemoteHostIssueMutationTargetDto
  extends RemoteHostIssueTargetDto, RemoteHostMutationIntentDto {
  expectedRevision: number;
}

export interface RemoteHostIssueUpdateDto extends RemoteHostIssueMutationTargetDto {
  patch: IssueUpdatePatchDto;
}

export type RemoteHostIssueMutationResultDto = IssueMutationResult;

export interface RemoteHostIssueResolveSessionDto extends RemoteHostCreateSessionDto {
  issueId: string;
  issueUpdatedAt: number;
  expectedRevision: number;
}

export type RemoteHostIssueResolveSessionResultDto = IssueResolveInNewSessionResult;

export interface RemoteHostFileChangePageRequestDto extends RemoteHostSessionTargetDto {
  cursor?: string;
  limit: number;
}

export type RemoteHostFileChangePageDto = SessionFileChangeListResult;

export interface RemoteHostFileChangeGetRequestDto extends RemoteHostSessionTargetDto {
  changeId: number;
}

export type RemoteHostFileChangeGetDto = SessionFileChangeGetResult;

export interface RemoteHostFileFinalDiffRequestDto extends RemoteHostSessionTargetDto {
  filePath: string;
}

export type RemoteHostFileFinalDiffDto = SessionFileFinalDiffResult;

export interface RemoteHostImageAssetRequestDto extends RemoteHostSessionTargetDto {
  source: {
    kind: 'remote-file-change';
    changeId: number;
    side: 'before' | 'after';
  };
}

export type RemoteHostImageAssetResultDto = LoadImageBlobResult;

export interface RemoteHostPendingRequestDto {
  id: string;
  sessionId: string;
  kind: 'ask-user-question' | 'diff-review' | 'exit-plan' | 'permission';
  status: 'cancelled' | 'denied' | 'expired' | 'pending' | 'resolved' | 'stale';
  createdAt: number;
  expiresAt: number | null;
  display: RemoteHostJsonObject;
}

export interface RemoteHostPendingListDto {
  requests: RemoteHostPendingRequestDto[];
  revision: number;
}

export type RemoteHostPendingAction =
  | 'accept'
  | 'approve'
  | 'deny'
  | 'reject'
  | 'submit';

export interface RemoteHostRuntimeControlsDto {
  adapterId: string;
  values: RemoteHostJsonObject;
  revision: number;
}

export interface RemoteHostRuntimeUpdateResultDto {
  controls: RemoteHostRuntimeControlsDto;
  effect: 'hot-applied' | 'handoff-required' | 'restart-required';
  replacementSessionId: string | null;
}

export interface RemoteHostRuntimeUpdateDto
  extends RemoteHostSessionTargetDto, RemoteHostMutationIntentDto {
  patch: RemoteHostJsonObject;
  expectedRevision: number;
}

export interface RemoteHostPendingResponseDto
  extends RemoteHostSessionTargetDto, RemoteHostMutationIntentDto {
  requestId: string;
  action: RemoteHostPendingAction;
  value?: RemoteHostJsonValue;
  expectedRevision: number;
  expectedPresentationDigest: string;
}

export interface RemoteHostPendingResponseResultDto {
  status: Exclude<RemoteHostPendingRequestDto['status'], 'pending'>;
  revision: number;
}

export interface RemoteHostAcceptedResultDto {
  accepted: boolean;
  revision: number;
}

export const REMOTE_HOST_RESOURCE_KINDS = [
  'session-list',
  'session-detail',
  'pending',
  'teams',
  'issues',
  'usage',
  'node-configuration',
  'node-assets',
] as const;

export type RemoteHostResourceKind = (typeof REMOTE_HOST_RESOURCE_KINDS)[number];

export type RemoteHostResourceRevisions = Record<RemoteHostResourceKind, number>;

export interface RemoteHostDataChangedDto {
  revision: number;
  profileId: string | null;
  reason: 'data' | 'profiles' | 'selection' | 'state';
  resources: RemoteHostResourceKind[];
}
