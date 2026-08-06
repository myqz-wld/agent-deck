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

export interface RemoteHostMutationIntentDto {
  intentId: string;
}

export interface RemoteHostCreateSessionDto extends RemoteHostMutationIntentDto {
  profileId: string;
  adapterId: string;
  projectRef: string;
  options: RemoteHostJsonObject;
}

export interface RemoteHostSessionTargetDto {
  profileId: string;
  sessionId: string;
}

export interface RemoteHostMutationTargetDto
  extends RemoteHostSessionTargetDto, RemoteHostMutationIntentDto {}

export interface RemoteHostSendDto
  extends RemoteHostSessionTargetDto, RemoteHostMutationIntentDto {
  text: string;
}

export interface RemoteHostSendResultDto {
  messageId: string;
  sequence: number;
  revision: number;
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
}

export interface RemoteHostPendingResponseResultDto {
  status: Exclude<RemoteHostPendingRequestDto['status'], 'pending'>;
  revision: number;
}

export interface RemoteHostAcceptedResultDto {
  accepted: boolean;
  revision: number;
}

export interface RemoteHostDataChangedDto {
  revision: number;
  profileId: string | null;
  reason: 'data' | 'profiles' | 'selection' | 'state';
}
