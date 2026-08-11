import type {
  RemoteHostEventListDto,
  RemoteHostFileChangeGetDto,
  RemoteHostFileChangePageDto,
  RemoteHostFileFinalDiffDto,
  RemoteHostJsonObject,
  RemoteHostJsonValue,
  RemoteHostPendingAction,
  RemoteHostPendingListDto,
  RemoteHostPendingRequestDto,
  RemoteHostProfileDto,
  RemoteHostRuntimeControlsDto,
  RemoteHostSessionSummaryDto,
  RemoteHostStateDto,
  RemoteHostSummaryListDto,
  RemoteHostSessionContextDto,
  RemoteHostSessionInputCapabilitiesDto,
  RemoteHostTaskListDto,
} from '@shared/remote-host';
import type {
  SessionConsoleAttachmentInput,
  SessionConsoleCapabilitiesParams,
  SessionConsoleCapabilitiesResult,
  SessionConsoleCreateOptions,
  SessionHandOffCommitResult,
  SessionHandOffPreviewParams,
  SessionHandOffPreviewResult,
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
  addressableIdentityKey?: string | null;
  busy: boolean;
  capabilities: ReadonlySet<string>;
  dataRevision: number;
  error: string | null;
  eventLoadError: string | null;
  events: RemoteHostEventListDto | null;
  historyLoadError?: string | null;
  historyLoading?: boolean;
  historySessions: readonly RemoteHostSessionSummaryDto[];
  hasMoreHistorySessions: boolean;
  hasMoreSessions: boolean;
  identity: string;
  loading: boolean;
  pendingBySession: ReadonlyMap<string, RemoteHostPendingListDto>;
  profile: RemoteHostProfileDto | null;
  recoveringWorker: boolean;
  runtime: RemoteHostRuntimeControlsDto | null;
  context?: RemoteHostSessionContextDto | null;
  inputCapabilities?: RemoteHostSessionInputCapabilitiesDto | null;
  summaryLoadError?: string | null;
  summaries: RemoteHostSummaryListDto | null;
  taskLoadError: string | null;
  tasks: RemoteHostTaskListDto | null;
  sessionTotal: number | null;
  selectedPending: RemoteHostPendingListDto | null;
  selectedSession: RemoteHostSessionSummaryDto | null;
  selectedSessionId: string | null;
  sessions: readonly RemoteHostSessionSummaryDto[];
  state: RemoteHostStateDto | null;
  usable: boolean;
  clearError(): void;
  createSession(input: RemoteSessionCreateInput): Promise<string>;
  getSessionCapabilities(
    request: SessionConsoleCapabilitiesParams,
  ): Promise<SessionConsoleCapabilitiesResult>;
  listWorkspaceDirectories(directory: string): Promise<WorkspaceDirectoryListResult>;
  listFileChanges(cursor?: string): Promise<RemoteHostFileChangePageDto>;
  getFileChange(changeId: number): Promise<RemoteHostFileChangeGetDto>;
  getFileFinalDiff(filePath: string): Promise<RemoteHostFileFinalDiffDto>;
  loadImageBlob(sessionId: string, source: ImageSource): Promise<LoadImageBlobResult>;
  planReviewTransport?(
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
  loadMoreSessions(): Promise<void>;
  refresh(): void;
  respondPending(
    presentation: RemotePendingPresentation,
    action: RemoteHostPendingAction,
    value?: RemoteHostJsonValue,
  ): Promise<void>;
  selectSession(sessionId: string | null): void;
  send(text: string, attachments?: SessionConsoleAttachmentInput[]): Promise<void>;
  steer(text: string, attachments?: SessionConsoleAttachmentInput[]): Promise<void>;
  updateRuntime(patch: RemoteHostJsonObject): Promise<void>;
}
