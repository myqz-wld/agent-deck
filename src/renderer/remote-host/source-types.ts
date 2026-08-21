import type {
  RemoteHostEventListDto,
  RemoteHostFileChangeGetDto,
  RemoteHostFileChangePageDto,
  RemoteHostFileFinalDiffDto,
  RemoteHostJsonObject,
  RemoteHostJsonValue,
  RemoteHostPendingAction,
  RemoteHostPendingIndexBucketDto,
  RemoteHostPendingListDto,
  RemoteHostPendingRequestDto,
  RemoteHostProfileDto,
  RemoteHostRuntimeControlsDto,
  RemoteHostResourceRevisions,
  RemoteHostSessionPresentationDto,
  RemoteHostSessionSummaryDto,
  RemoteHostStateDto,
  RemoteHostSummaryListDto,
  RemoteHostSessionContextDto,
  RemoteHostSessionInputCapabilitiesDto,
  RemoteHostTaskListDto,
  RemoteHostSessionOutgoingDto,
} from '@shared/remote-host';
import type {
  SessionConsoleAttachmentInput,
  SessionConsoleCapabilitiesParams,
  SessionConsoleCapabilitiesResult,
  SessionConsoleCreateOptions,
  SessionHandOffCommitResult,
  SessionHandOffPreviewParams,
  SessionHandOffPreviewResult,
  SessionPresentationCountsDto,
  WorkspaceDirectoryListResult,
} from '@contracts/index';
import type { ImageSource, LoadImageBlobResult } from '@shared/types';
import type { PlanDeepReviewTransport } from '@renderer/plan-review/transport';

export interface RemoteSessionCreateInput {
  adapterId: string;
  attachments: SessionConsoleAttachmentInput[];
  capabilityRevision: string;
  initialMessage: string;
  options: SessionConsoleCreateOptions;
  workingDirectory: string;
}

export interface RemotePendingPresentation {
  digest: string;
  request: RemoteHostPendingRequestDto;
  revision: number;
  sourceIdentity: string;
}

export interface RemoteSessionSourceView {
  addressableIdentityKey: string | null;
  busy: boolean;
  capabilities: ReadonlySet<string>;
  dataRevision: number;
  resourceRevisions: RemoteHostResourceRevisions;
  error: string | null;
  eventLoadError: string | null;
  events: RemoteHostEventListDto | null;
  historyInitialized: boolean;
  historyLoadError: string | null;
  historyLoading: boolean;
  historyPaginationBusy: boolean;
  historyArchivedOnly: boolean;
  historyQuery: string;
  historySessions: readonly RemoteHostSessionPresentationDto[];
  hasMoreHistorySessions: boolean;
  hasMoreSessions: boolean;
  identity: string;
  loading: boolean;
  livePaginationBusy: boolean;
  pendingBuckets: readonly RemoteHostPendingIndexBucketDto[];
  pendingBySession: ReadonlyMap<string, RemoteHostPendingListDto>;
  pendingInitialized: boolean;
  pendingLoading: boolean;
  pendingPaginationBusy: boolean;
  pendingLoadError: string | null;
  pendingTotal: number | null;
  pendingScanTruncated: boolean;
  hasMorePending: boolean;
  presentationCounts: SessionPresentationCountsDto | null;
  profile: RemoteHostProfileDto | null;
  recoveringWorker: boolean;
  runtime: RemoteHostRuntimeControlsDto | null;
  runtimeLoadError: string | null;
  context: RemoteHostSessionContextDto | null;
  contextLoadError: string | null;
  inputCapabilities: RemoteHostSessionInputCapabilitiesDto | null;
  inputLoadError: string | null;
  summaryLoadError: string | null;
  summaries: RemoteHostSummaryListDto | null;
  taskLoadError: string | null;
  tasks: RemoteHostTaskListDto | null;
  sessionTotal: number | null;
  selectedPending: RemoteHostPendingListDto | null;
  selectedSession: RemoteHostSessionSummaryDto | null;
  selectedSessionId: string | null;
  sessions: readonly RemoteHostSessionPresentationDto[];
  state: RemoteHostStateDto | null;
  usable: boolean;
  clearError(): void;
  archiveHistorySession(session: RemoteHostSessionPresentationDto): Promise<void>;
  createSession(input: RemoteSessionCreateInput): Promise<string>;
  createWorkspaceDirectory(parentDirectory: string, name: string): Promise<string>;
  deleteHistorySession(session: RemoteHostSessionPresentationDto): Promise<void>;
  getSessionCapabilities(
    request: SessionConsoleCapabilitiesParams,
  ): Promise<SessionConsoleCapabilitiesResult>;
  listWorkspaceDirectories(directory: string): Promise<WorkspaceDirectoryListResult>;
  listFileChanges(cursor?: string): Promise<RemoteHostFileChangePageDto>;
  getFileChange(changeId: number): Promise<RemoteHostFileChangeGetDto>;
  getFileFinalDiff(filePath: string): Promise<RemoteHostFileFinalDiffDto>;
  loadImageBlob(sessionId: string, source: ImageSource): Promise<LoadImageBlobResult>;
  planReviewTransport(
    presentation: RemotePendingPresentation,
    agentId: string,
  ): PlanDeepReviewTransport | null;
  interrupt(): Promise<void>;
  previewHandOff(
    input: Omit<SessionHandOffPreviewParams, 'sessionId'>,
  ): Promise<SessionHandOffPreviewResult>;
  commitHandOff(
    input: Omit<SessionHandOffPreviewParams, 'sessionId'> & {
      expectedBindingDigest: string;
    },
  ): Promise<SessionHandOffCommitResult>;
  loadMoreHistorySessions(): Promise<void>;
  listOutgoing(
    adapterId: 'claude-code' | 'codex-cli' | 'grok-build',
  ): Promise<RemoteHostSessionOutgoingDto>;
  loadMorePending(): Promise<void>;
  loadMoreSessions(): Promise<void>;
  reactivateSession(session: RemoteHostSessionPresentationDto): Promise<void>;
  refresh(): void;
  respondPending(
    presentation: RemotePendingPresentation,
    action: RemoteHostPendingAction,
    value?: RemoteHostJsonValue,
  ): Promise<void>;
  removeOutgoing(messageId: string): Promise<boolean>;
  selectSession(sessionId: string | null): void;
  setHistoryQuery(query: string): void;
  setHistoryArchivedOnly(archivedOnly: boolean): void;
  send(text: string, attachments?: SessionConsoleAttachmentInput[]): Promise<void>;
  steer(text: string, attachments?: SessionConsoleAttachmentInput[]): Promise<void>;
  updateRuntime(patch: RemoteHostJsonObject): Promise<void>;
  unarchiveHistorySession(session: RemoteHostSessionPresentationDto): Promise<void>;
}
