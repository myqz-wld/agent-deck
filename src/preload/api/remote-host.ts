import { ipcRenderer } from 'electron';

import { IpcEvent, RemoteHostIpcInvoke } from '@shared/ipc-channels';
import type {
  RemoteHostAcceptedResultDto,
  RemoteHostCreateSessionDto,
  RemoteHostConnectionSelectionDto,
  RemoteHostDataChangedDto,
  RemoteHostFileChangeGetDto,
  RemoteHostFileChangeGetRequestDto,
  RemoteHostFileChangePageDto,
  RemoteHostFileChangePageRequestDto,
  RemoteHostFileFinalDiffDto,
  RemoteHostFileFinalDiffRequestDto,
  RemoteHostEventListDto,
  RemoteHostEventListRequestDto,
  RemoteHostHistoryPageDto,
  RemoteHostHistoryRequestDto,
  RemoteHostImageAssetRequestDto,
  RemoteHostImageAssetResultDto,
  RemoteHostIssueGetDto,
  RemoteHostIssueListDto,
  RemoteHostIssueListRequestDto,
  RemoteHostIssueMutationResultDto,
  RemoteHostIssueMutationTargetDto,
  RemoteHostIssueResolveSessionDto,
  RemoteHostIssueResolveSessionResultDto,
  RemoteHostIssueTargetDto,
  RemoteHostIssueUpdateDto,
  RemoteHostMutationTargetDto,
  RemoteHostPageRequestDto,
  RemoteHostPendingListDto,
  RemoteHostPendingResponseDto,
  RemoteHostPendingResponseResultDto,
  RemoteHostPlanReviewAcceptedDto,
  RemoteHostPlanReviewAskDto,
  RemoteHostPlanReviewFeedbackDto,
  RemoteHostPlanReviewSessionDto,
  RemoteHostPlanReviewTargetDto,
  RemoteHostProfileDraftDto,
  RemoteHostProjectPageDto,
  RemoteHostRuntimeControlsDto,
  RemoteHostRuntimeUpdateDto,
  RemoteHostRuntimeUpdateResultDto,
  RemoteHostSendDto,
  RemoteHostSendResultDto,
  RemoteHostSessionPageDto,
  RemoteHostSessionPageRequestDto,
  RemoteHostSessionCapabilitiesDto,
  RemoteHostSessionCapabilitiesRequestDto,
  RemoteHostSessionSummaryDto,
  RemoteHostSessionTargetDto,
  RemoteHostSnapshotDto,
  RemoteHostSourceMode,
  RemoteHostSummaryListDto,
  RemoteHostSummaryRequestDto,
  RemoteHostTaskListDto,
  RemoteHostTaskListRequestDto,
  RemoteHostTeamAddMemberDto,
  RemoteHostTeamAddMemberResultDto,
  RemoteHostTeamGetDto,
  RemoteHostTeamListDto,
  RemoteHostTeamListRequestDto,
  RemoteHostTeamMutationResultDto,
  RemoteHostTeamMutationTargetDto,
  RemoteHostTeamShutdownResultDto,
  RemoteHostTeamTargetDto,
  RemoteHostUsageProviderDto,
  RemoteHostUsageProviderRequestDto,
  RemoteHostUsageTokenDto,
  RemoteHostUsageTokenRequestDto,
  RemoteHostWorkspaceDirectoryListDto,
  RemoteHostWorkspaceDirectoryRequestDto,
} from '@shared/remote-host';

import { subscribe } from './_helpers';

export const remoteHostApi = {
  getRemoteHostSnapshot: (): Promise<RemoteHostSnapshotDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.Snapshot),
  addRemoteHostProfile: (draft: RemoteHostProfileDraftDto): Promise<RemoteHostSnapshotDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.ProfileAdd, draft),
  updateRemoteHostProfile: (
    profileId: string,
    draft: RemoteHostProfileDraftDto,
  ): Promise<RemoteHostSnapshotDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.ProfileUpdate, profileId, draft),
  removeRemoteHostProfile: (profileId: string): Promise<RemoteHostSnapshotDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.ProfileRemove, profileId),
  selectRemoteHostProfile: (profileId: string): Promise<RemoteHostSnapshotDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.ProfileSelect, profileId),
  setRemoteHostSourceMode: (mode: RemoteHostSourceMode): Promise<RemoteHostSnapshotDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.SourceModeSet, mode),
  connectRemoteHost: (profileId: string): Promise<RemoteHostSnapshotDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.Connect, profileId),
  disconnectRemoteHost: (profileId: string): Promise<RemoteHostSnapshotDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.Disconnect, profileId),
  chooseRemoteHostConnection: (): Promise<RemoteHostConnectionSelectionDto | null> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.ChooseConnection),

  listRemoteHostSessions: (
    request: RemoteHostSessionPageRequestDto,
  ): Promise<RemoteHostSessionPageDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.SessionsList, request),
  getRemoteHostSession: (
    request: RemoteHostSessionTargetDto,
  ): Promise<RemoteHostSessionSummaryDto | null> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.SessionGet, request),
  getRemoteHostSessionCapabilities: (
    request: RemoteHostSessionCapabilitiesRequestDto,
  ): Promise<RemoteHostSessionCapabilitiesDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.SessionCapabilities, request),
  listRemoteHostWorkspaceDirectories: (
    request: RemoteHostWorkspaceDirectoryRequestDto,
  ): Promise<RemoteHostWorkspaceDirectoryListDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.WorkspaceDirectoriesList, request),
  listRemoteHostProjects: (
    request: RemoteHostPageRequestDto,
  ): Promise<RemoteHostProjectPageDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.ProjectsList, request),
  createRemoteHostSession: (
    request: RemoteHostCreateSessionDto,
  ): Promise<{ sessionId: string; revision: number }> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.SessionCreate, request),
  listRemoteHostHistory: (
    request: RemoteHostHistoryRequestDto,
  ): Promise<RemoteHostHistoryPageDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.HistoryList, request),
  listRemoteHostEvents: (
    request: RemoteHostEventListRequestDto,
  ): Promise<RemoteHostEventListDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.EventsList, request),
  listRemoteHostSummaries: (
    request: RemoteHostSummaryRequestDto,
  ): Promise<RemoteHostSummaryListDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.SummariesList, request),
  listRemoteHostTasks: (
    request: RemoteHostTaskListRequestDto,
  ): Promise<RemoteHostTaskListDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.TasksList, request),
  listRemoteHostTeams: (
    request: RemoteHostTeamListRequestDto,
  ): Promise<RemoteHostTeamListDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.TeamsList, request),
  getRemoteHostTeam: (request: RemoteHostTeamTargetDto): Promise<RemoteHostTeamGetDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.TeamGet, request),
  archiveRemoteHostTeam: (
    request: RemoteHostTeamMutationTargetDto,
  ): Promise<RemoteHostTeamMutationResultDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.TeamArchive, request),
  addRemoteHostTeamMember: (
    request: RemoteHostTeamAddMemberDto,
  ): Promise<RemoteHostTeamAddMemberResultDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.TeamAddMember, request),
  shutdownRemoteHostTeamTeammates: (
    request: RemoteHostTeamMutationTargetDto,
  ): Promise<RemoteHostTeamShutdownResultDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.TeamShutdownTeammates, request),
  getRemoteHostTokenUsage: (
    request: RemoteHostUsageTokenRequestDto,
  ): Promise<RemoteHostUsageTokenDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.UsageTokensGet, request),
  getRemoteHostProviderUsage: (
    request: RemoteHostUsageProviderRequestDto,
  ): Promise<RemoteHostUsageProviderDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.UsageProvidersGet, request),
  listRemoteHostIssues: (
    request: RemoteHostIssueListRequestDto,
  ): Promise<RemoteHostIssueListDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.IssuesList, request),
  getRemoteHostIssue: (request: RemoteHostIssueTargetDto): Promise<RemoteHostIssueGetDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.IssueGet, request),
  updateRemoteHostIssue: (
    request: RemoteHostIssueUpdateDto,
  ): Promise<RemoteHostIssueMutationResultDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.IssueUpdate, request),
  softDeleteRemoteHostIssue: (
    request: RemoteHostIssueMutationTargetDto,
  ): Promise<RemoteHostIssueMutationResultDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.IssueSoftDelete, request),
  undeleteRemoteHostIssue: (
    request: RemoteHostIssueMutationTargetDto,
  ): Promise<RemoteHostIssueMutationResultDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.IssueUndelete, request),
  resolveRemoteHostIssueInNewSession: (
    request: RemoteHostIssueResolveSessionDto,
  ): Promise<RemoteHostIssueResolveSessionResultDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.IssueResolveInNewSession, request),
  listRemoteHostFileChanges: (
    request: RemoteHostFileChangePageRequestDto,
  ): Promise<RemoteHostFileChangePageDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.FileChangesList, request),
  getRemoteHostFileChange: (
    request: RemoteHostFileChangeGetRequestDto,
  ): Promise<RemoteHostFileChangeGetDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.FileChangeGet, request),
  getRemoteHostFileFinalDiff: (
    request: RemoteHostFileFinalDiffRequestDto,
  ): Promise<RemoteHostFileFinalDiffDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.FileFinalDiffGet, request),
  loadRemoteHostImageAsset: (
    request: RemoteHostImageAssetRequestDto,
  ): Promise<RemoteHostImageAssetResultDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.ImageAssetLoad, request),
  sendRemoteHostMessage: (request: RemoteHostSendDto): Promise<RemoteHostSendResultDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.SessionSend, request),
  interruptRemoteHostSession: (
    request: RemoteHostMutationTargetDto,
  ): Promise<RemoteHostAcceptedResultDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.SessionInterrupt, request),
  steerRemoteHostSession: (request: RemoteHostSendDto): Promise<RemoteHostAcceptedResultDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.SessionSteer, request),
  listRemoteHostPending: (
    request: RemoteHostSessionTargetDto,
  ): Promise<RemoteHostPendingListDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.PendingList, request),
  respondRemoteHostPending: (
    request: RemoteHostPendingResponseDto,
  ): Promise<RemoteHostPendingResponseResultDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.PendingRespond, request),
  startRemoteHostPlanReview: (
    request: RemoteHostPlanReviewTargetDto,
  ): Promise<RemoteHostPlanReviewSessionDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.PlanReviewStart, request),
  askRemoteHostPlanReview: (
    request: RemoteHostPlanReviewAskDto,
  ): Promise<RemoteHostPlanReviewAcceptedDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.PlanReviewAsk, request),
  generateRemoteHostPlanReviewFeedback: (
    request: RemoteHostPlanReviewTargetDto,
  ): Promise<RemoteHostPlanReviewFeedbackDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.PlanReviewFeedback, request),
  getRemoteHostRuntime: (
    request: RemoteHostSessionTargetDto,
  ): Promise<RemoteHostRuntimeControlsDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.RuntimeGet, request),
  updateRemoteHostRuntime: (
    request: RemoteHostRuntimeUpdateDto,
  ): Promise<RemoteHostRuntimeUpdateResultDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.RuntimeUpdate, request),
  onRemoteHostChanged: (callback: (event: RemoteHostDataChangedDto) => void): (() => void) =>
    subscribe<RemoteHostDataChangedDto>(IpcEvent.RemoteHostChanged, callback),
};
