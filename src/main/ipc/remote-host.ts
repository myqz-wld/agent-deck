import { dialog, type OpenDialogOptions } from 'electron';

import { eventBus } from '@main/event-bus';
import { makeSafeSend } from '@main/index/_deps';
import { getFloatingWindow } from '@main/window';
import {
  getRemoteHostService,
  parseRemoteHostCreateSession,
  parseRemoteHostHistoryRequest,
  parseRemoteHostMutationTarget,
  parseRemoteHostPageRequest,
  parseRemoteHostPendingResponse,
  parseRemoteHostProfileDraft,
  parseRemoteHostProfileId,
  parseRemoteHostSourceMode,
  parseRemoteHostRuntimeUpdate,
  parseRemoteHostSend,
  parseRemoteHostSessionPageRequest,
  parseRemoteHostSessionTarget,
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
  on(RemoteHostIpcInvoke.ProjectsList, (_event, request) => safely(() =>
    getRemoteHostService().listProjects(parseRemoteHostPageRequest(request))));
  on(RemoteHostIpcInvoke.SessionCreate, (_event, request) => safely(() =>
    getRemoteHostService().createSession(parseRemoteHostCreateSession(request))));
  on(RemoteHostIpcInvoke.HistoryList, (_event, request) => safely(() =>
    getRemoteHostService().listHistory(parseRemoteHostHistoryRequest(request))));
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
  on(RemoteHostIpcInvoke.RuntimeGet, (_event, request) => safely(() =>
    getRemoteHostService().getRuntime(parseRemoteHostSessionTarget(request))));
  on(RemoteHostIpcInvoke.RuntimeUpdate, (_event, request) => safely(() =>
    getRemoteHostService().updateRuntime(parseRemoteHostRuntimeUpdate(request))));
}
