import { ipcRenderer } from 'electron';

import { IpcEvent, RemoteHostIpcInvoke } from '@shared/ipc-channels';
import type {
  RemoteHostAcceptedResultDto,
  RemoteHostCreateSessionDto,
  RemoteHostCredentialKind,
  RemoteHostCredentialSelectionDto,
  RemoteHostDataChangedDto,
  RemoteHostHistoryPageDto,
  RemoteHostHistoryRequestDto,
  RemoteHostMutationTargetDto,
  RemoteHostPageRequestDto,
  RemoteHostPendingListDto,
  RemoteHostPendingResponseDto,
  RemoteHostPendingResponseResultDto,
  RemoteHostProfileDraftDto,
  RemoteHostProjectPageDto,
  RemoteHostRuntimeControlsDto,
  RemoteHostRuntimeUpdateDto,
  RemoteHostRuntimeUpdateResultDto,
  RemoteHostSendDto,
  RemoteHostSendResultDto,
  RemoteHostSessionPageDto,
  RemoteHostSessionPageRequestDto,
  RemoteHostSessionSummaryDto,
  RemoteHostSessionTargetDto,
  RemoteHostSnapshotDto,
  RemoteHostSourceMode,
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
  chooseRemoteHostCredential: (
    kind: RemoteHostCredentialKind,
  ): Promise<RemoteHostCredentialSelectionDto | null> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.ChooseCredential, kind),

  listRemoteHostSessions: (
    request: RemoteHostSessionPageRequestDto,
  ): Promise<RemoteHostSessionPageDto> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.SessionsList, request),
  getRemoteHostSession: (
    request: RemoteHostSessionTargetDto,
  ): Promise<RemoteHostSessionSummaryDto | null> =>
    ipcRenderer.invoke(RemoteHostIpcInvoke.SessionGet, request),
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
