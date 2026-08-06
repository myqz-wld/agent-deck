import type {
  RemoteHostHistoryPageDto,
  RemoteHostJsonObject,
  RemoteHostJsonValue,
  RemoteHostPendingAction,
  RemoteHostPendingListDto,
  RemoteHostPendingRequestDto,
  RemoteHostProfileDto,
  RemoteHostRuntimeControlsDto,
  RemoteHostSessionSummaryDto,
  RemoteHostStateDto,
} from '@shared/remote-host';

export interface RemotePendingPresentation {
  digest: string;
  request: RemoteHostPendingRequestDto;
  revision: number;
  sourceIdentity: string;
}

export interface RemoteSessionSourceView {
  busy: boolean;
  capabilities: ReadonlySet<string>;
  error: string | null;
  history: RemoteHostHistoryPageDto | null;
  historySessions: readonly RemoteHostSessionSummaryDto[];
  hasMoreHistorySessions: boolean;
  hasMoreSessions: boolean;
  identity: string;
  loading: boolean;
  pendingBySession: ReadonlyMap<string, RemoteHostPendingListDto>;
  profile: RemoteHostProfileDto | null;
  recoveringWorker: boolean;
  runtime: RemoteHostRuntimeControlsDto | null;
  sessionTotal: number | null;
  selectedPending: RemoteHostPendingListDto | null;
  selectedSession: RemoteHostSessionSummaryDto | null;
  selectedSessionId: string | null;
  sessions: readonly RemoteHostSessionSummaryDto[];
  state: RemoteHostStateDto | null;
  usable: boolean;
  clearError(): void;
  createSession(
    adapterId: string,
    workingDirectory: string,
    initialMessage: string,
  ): Promise<void>;
  interrupt(): Promise<void>;
  loadMoreHistorySessions(): Promise<void>;
  loadMoreSessions(): Promise<void>;
  refresh(): void;
  respondPending(
    presentation: RemotePendingPresentation,
    action: RemoteHostPendingAction,
    value?: RemoteHostJsonValue,
  ): Promise<void>;
  selectSession(sessionId: string | null): void;
  send(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  updateRuntime(patch: RemoteHostJsonObject): Promise<void>;
}
