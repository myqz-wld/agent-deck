import { dialog, type OpenDialogOptions } from 'electron';

import { eventBus } from '@main/event-bus';
import { makeSafeSend } from '@main/index/_deps';
import { getFloatingWindow } from '@main/window';
import {
  getRemoteHostService,
  parseRemoteHostCreateSession,
  parseRemoteHostFileChangeGetRequest,
  parseRemoteHostFileChangePageRequest,
  parseRemoteHostFileFinalDiffRequest,
  parseRemoteHostEventListRequest,
  parseRemoteHostHistoryRequest,
  parseRemoteHostImageAssetRequest,
  parseRemoteHostIssueListRequest,
  parseRemoteHostIssueMutationTarget,
  parseRemoteHostIssueResolveSession,
  parseRemoteHostIssueTarget,
  parseRemoteHostIssueUpdate,
  parseRemoteHostMutationTarget,
  parseRemoteHostPageRequest,
  parseRemoteHostPendingResponse,
  parseRemoteHostPlanReviewAsk,
  parseRemoteHostPlanReviewTarget,
  parseRemoteHostProfileDraft,
  parseRemoteHostProfileId,
  parseRemoteHostSourceMode,
  parseRemoteHostSummaryRequest,
  parseRemoteHostTaskListRequest,
  parseRemoteHostTeamAddMember,
  parseRemoteHostTeamList,
  parseRemoteHostTeamMutationTarget,
  parseRemoteHostTeamTarget,
  parseRemoteHostUsageProvider,
  parseRemoteHostUsageToken,
  parseRemoteHostNodeConfiguration,
  parseRemoteHostNodeHook,
  parseRemoteHostNodeHookMutation,
  parseRemoteHostNodeAssetList,
  parseRemoteHostNodeAssetContent,
  parseRemoteHostNodeAssetConvention,
  parseRemoteHostRuntimeUpdate,
  parseRemoteHostSend,
  parseRemoteHostSessionCapabilitiesRequest,
  parseRemoteHostSessionPageRequest,
  parseRemoteHostSessionTarget,
  parseRemoteHostWorkspaceDirectoryRequest,
  publicRemoteHostError,
} from '@main/remote-host';
import { IpcEvent, RemoteHostIpcInvoke } from '@shared/ipc-channels';
import { on } from './_helpers';

let connectionDialog: Promise<string | null> | null = null;

async function chooseConnectionFile(): Promise<string | null> {
  if (connectionDialog) return connectionDialog;
  connectionDialog = showConnectionDialog().finally(() => { connectionDialog = null; });
  return connectionDialog;
}

async function showConnectionDialog(): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: '导入 Agent Deck 连接凭证',
    properties: ['openFile'],
    filters: [
      { name: 'Agent Deck 连接凭证', extensions: ['agentdeck-connection', 'json'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  };
  const window = getFloatingWindow().window;
  const result = await (window
    ? dialog.showOpenDialog(window, options)
    : dialog.showOpenDialog(options));
  return result.canceled || result.filePaths.length !== 1 ? null : result.filePaths[0];
}

async function safely<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw publicRemoteHostError(error);
  }
}

export function registerRemoteHostIpc(): void {
  const safeSend = makeSafeSend(() => getFloatingWindow().window);
  eventBus.on('remote-host-changed', (event) => safeSend(IpcEvent.RemoteHostChanged, event));

  on(RemoteHostIpcInvoke.Snapshot, () => safely(() => getRemoteHostService().getSnapshot()));
  on(RemoteHostIpcInvoke.ProfileAdd, (_event, draft) => safely(() =>
    getRemoteHostService().addProfile(parseRemoteHostProfileDraft(draft))));
  on(RemoteHostIpcInvoke.ProfileUpdate, (_event, profileId, draft) => safely(() =>
    getRemoteHostService().updateProfile(
      parseRemoteHostProfileId(profileId),
      parseRemoteHostProfileDraft(draft),
    )));
  on(RemoteHostIpcInvoke.ProfileRemove, (_event, profileId) => safely(() =>
    getRemoteHostService().removeProfile(parseRemoteHostProfileId(profileId))));
  on(RemoteHostIpcInvoke.ProfileSelect, (_event, profileId) => safely(() =>
    getRemoteHostService().selectProfile(parseRemoteHostProfileId(profileId))));
  on(RemoteHostIpcInvoke.SourceModeSet, (_event, mode) => safely(() =>
    getRemoteHostService().setSourceMode(parseRemoteHostSourceMode(mode))));
  on(RemoteHostIpcInvoke.Connect, (_event, profileId) => safely(() =>
    getRemoteHostService().connect(parseRemoteHostProfileId(profileId))));
  on(RemoteHostIpcInvoke.Disconnect, (_event, profileId) => safely(() =>
    getRemoteHostService().disconnect(parseRemoteHostProfileId(profileId))));

  on(RemoteHostIpcInvoke.ChooseConnection, () => safely(async () => {
    const path = await chooseConnectionFile();
    return path ? getRemoteHostService().captureConnection(path) : null;
  }));

  on(RemoteHostIpcInvoke.SessionsList, (_event, request) => safely(() =>
    getRemoteHostService().listSessions(parseRemoteHostSessionPageRequest(request))));
  on(RemoteHostIpcInvoke.SessionGet, (_event, request) => safely(() =>
    getRemoteHostService().getSession(parseRemoteHostSessionTarget(request))));
  on(RemoteHostIpcInvoke.SessionCapabilities, (_event, request) => safely(() =>
    getRemoteHostService().getSessionCapabilities(
      parseRemoteHostSessionCapabilitiesRequest(request),
    )));
  on(RemoteHostIpcInvoke.WorkspaceDirectoriesList, (_event, request) => safely(() =>
    getRemoteHostService().listWorkspaceDirectories(
      parseRemoteHostWorkspaceDirectoryRequest(request),
    )));
  on(RemoteHostIpcInvoke.ProjectsList, (_event, request) => safely(() =>
    getRemoteHostService().listProjects(parseRemoteHostPageRequest(request))));
  on(RemoteHostIpcInvoke.SessionCreate, (_event, request) => safely(() =>
    getRemoteHostService().createSession(parseRemoteHostCreateSession(request))));
  on(RemoteHostIpcInvoke.HistoryList, (_event, request) => safely(() =>
    getRemoteHostService().listHistory(parseRemoteHostHistoryRequest(request))));
  on(RemoteHostIpcInvoke.EventsList, (_event, request) => safely(() =>
    getRemoteHostService().detail.listEvents(parseRemoteHostEventListRequest(request))));
  on(RemoteHostIpcInvoke.SummariesList, (_event, request) => safely(() =>
    getRemoteHostService().detail.listSummaries(parseRemoteHostSummaryRequest(request))));
  on(RemoteHostIpcInvoke.TasksList, (_event, request) => safely(() =>
    getRemoteHostService().detail.listTasks(parseRemoteHostTaskListRequest(request))));
  on(RemoteHostIpcInvoke.TeamsList, (_event, request) => safely(() =>
    getRemoteHostService().teams.list(parseRemoteHostTeamList(request))));
  on(RemoteHostIpcInvoke.TeamGet, (_event, request) => safely(() =>
    getRemoteHostService().teams.get(parseRemoteHostTeamTarget(request))));
  on(RemoteHostIpcInvoke.TeamArchive, (_event, request) => safely(() =>
    getRemoteHostService().teams.archive(parseRemoteHostTeamMutationTarget(request))));
  on(RemoteHostIpcInvoke.TeamAddMember, (_event, request) => safely(() =>
    getRemoteHostService().teams.addMember(parseRemoteHostTeamAddMember(request))));
  on(RemoteHostIpcInvoke.TeamShutdownTeammates, (_event, request) => safely(() =>
    getRemoteHostService().teams.shutdownTeammates(
      parseRemoteHostTeamMutationTarget(request),
    )));
  on(RemoteHostIpcInvoke.UsageTokensGet, (_event, request) => safely(() =>
    getRemoteHostService().usage.tokens(parseRemoteHostUsageToken(request))));
  on(RemoteHostIpcInvoke.UsageProvidersGet, (_event, request) => safely(() =>
    getRemoteHostService().usage.providers(parseRemoteHostUsageProvider(request))));
  on(RemoteHostIpcInvoke.NodeConfigurationGet, (_event, request) => safely(() =>
    getRemoteHostService().nodeConfiguration.get(
      parseRemoteHostNodeConfiguration(request),
    )));
  on(RemoteHostIpcInvoke.NodeHookStatus, (_event, request) => safely(() =>
    getRemoteHostService().nodeConfiguration.status(parseRemoteHostNodeHook(request))));
  on(RemoteHostIpcInvoke.NodeHookInstall, (_event, request) => safely(() =>
    getRemoteHostService().nodeConfiguration.install(
      parseRemoteHostNodeHookMutation(request),
    )));
  on(RemoteHostIpcInvoke.NodeHookUninstall, (_event, request) => safely(() =>
    getRemoteHostService().nodeConfiguration.uninstall(
      parseRemoteHostNodeHookMutation(request),
    )));
  on(RemoteHostIpcInvoke.NodeAssetsList, (_event, request) => safely(() =>
    getRemoteHostService().nodeAssets.list(parseRemoteHostNodeAssetList(request))));
  on(RemoteHostIpcInvoke.NodeAssetContentGet, (_event, request) => safely(() =>
    getRemoteHostService().nodeAssets.content(parseRemoteHostNodeAssetContent(request))));
  on(RemoteHostIpcInvoke.NodeAssetConventionGet, (_event, request) => safely(() =>
    getRemoteHostService().nodeAssets.convention(
      parseRemoteHostNodeAssetConvention(request),
    )));
  on(RemoteHostIpcInvoke.IssuesList, (_event, request) => safely(() =>
    getRemoteHostService().issues.list(parseRemoteHostIssueListRequest(request))));
  on(RemoteHostIpcInvoke.IssueGet, (_event, request) => safely(() =>
    getRemoteHostService().issues.get(parseRemoteHostIssueTarget(request))));
  on(RemoteHostIpcInvoke.IssueUpdate, (_event, request) => safely(() =>
    getRemoteHostService().issues.update(parseRemoteHostIssueUpdate(request))));
  on(RemoteHostIpcInvoke.IssueSoftDelete, (_event, request) => safely(() =>
    getRemoteHostService().issues.softDelete(parseRemoteHostIssueMutationTarget(request))));
  on(RemoteHostIpcInvoke.IssueUndelete, (_event, request) => safely(() =>
    getRemoteHostService().issues.undelete(parseRemoteHostIssueMutationTarget(request))));
  on(RemoteHostIpcInvoke.IssueResolveInNewSession, (_event, request) => safely(() =>
    getRemoteHostService().issues.resolveInNewSession(
      parseRemoteHostIssueResolveSession(request),
    )));
  on(RemoteHostIpcInvoke.FileChangesList, (_event, request) => safely(() =>
    getRemoteHostService().detail.listFileChanges(parseRemoteHostFileChangePageRequest(request))));
  on(RemoteHostIpcInvoke.FileChangeGet, (_event, request) => safely(() =>
    getRemoteHostService().detail.getFileChange(parseRemoteHostFileChangeGetRequest(request))));
  on(RemoteHostIpcInvoke.FileFinalDiffGet, (_event, request) => safely(() =>
    getRemoteHostService().detail.getFileFinalDiff(parseRemoteHostFileFinalDiffRequest(request))));
  on(RemoteHostIpcInvoke.ImageAssetLoad, (_event, request) => safely(() =>
    getRemoteHostService().detail.loadImageAsset(parseRemoteHostImageAssetRequest(request))));
  on(RemoteHostIpcInvoke.SessionSend, (_event, request) => safely(() =>
    getRemoteHostService().send(parseRemoteHostSend(request))));
  on(RemoteHostIpcInvoke.SessionInterrupt, (_event, request) => safely(() =>
    getRemoteHostService().interrupt(parseRemoteHostMutationTarget(request))));
  on(RemoteHostIpcInvoke.SessionSteer, (_event, request) => safely(() =>
    getRemoteHostService().steer(parseRemoteHostSend(request))));
  on(RemoteHostIpcInvoke.PendingList, (_event, request) => safely(() =>
    getRemoteHostService().listPending(parseRemoteHostSessionTarget(request))));
  on(RemoteHostIpcInvoke.PendingRespond, (_event, request) => safely(() =>
    getRemoteHostService().respondPending(parseRemoteHostPendingResponse(request))));
  on(RemoteHostIpcInvoke.PlanReviewStart, (_event, request) => safely(() =>
    getRemoteHostService().planReviews.start(parseRemoteHostPlanReviewTarget(request))));
  on(RemoteHostIpcInvoke.PlanReviewAsk, (_event, request) => safely(() =>
    getRemoteHostService().planReviews.ask(parseRemoteHostPlanReviewAsk(request))));
  on(RemoteHostIpcInvoke.PlanReviewFeedback, (_event, request) => safely(() =>
    getRemoteHostService().planReviews.feedback(parseRemoteHostPlanReviewTarget(request))));
  on(RemoteHostIpcInvoke.RuntimeGet, (_event, request) => safely(() =>
    getRemoteHostService().getRuntime(parseRemoteHostSessionTarget(request))));
  on(RemoteHostIpcInvoke.RuntimeUpdate, (_event, request) => safely(() =>
    getRemoteHostService().updateRuntime(parseRemoteHostRuntimeUpdate(request))));
}
