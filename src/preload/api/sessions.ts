/**
 * preload/api/sessions: 会话相关 IPC facade。
 *
 * 包含会话 CRUD / 历史查询 / 子表（events / file_changes / summaries）拉取，以及
 * 会话续接上下文三阶段（prepare + commit/cancel）。
 */

import { ipcRenderer } from 'electron';
import { IpcInvoke } from '@shared/ipc-channels';
import type {
  AgentEvent,
  FileFinalDiffResult,
  FileChangeRecord,
  SessionHandOffCommitResponse,
  SessionHandOffPreparation,
  SessionHandOffPrepareRequest,
  SessionRecord,
  SummaryRecord,
  TaskRecord,
} from '@shared/types';

export const sessionsApi = {
  // 会话
  listSessions: (): Promise<SessionRecord[]> => ipcRenderer.invoke(IpcInvoke.SessionList),
  /**
   * 历史会话列表（含 closed 与归档）。filters 字段透传给 sessionRepo.listHistory。
   * 此前曾走 window.electronIpc.invoke 兜底通道，typo 不会被 TS 拦截 → silent fail；
   * 改为强类型 facade 后 channel 名就只有这一处真值。
   */
  listSessionHistory: (filters: {
    agentId?: string;
    cwd?: string;
    fromTs?: number;
    toTs?: number;
    keyword?: string;
    archivedOnly?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<SessionRecord[]> => ipcRenderer.invoke(IpcInvoke.SessionListHistory, filters),
  getSession: (id: string): Promise<SessionRecord | null> =>
    ipcRenderer.invoke(IpcInvoke.SessionGet, id),
  archiveSession: (id: string): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.SessionArchive, id),
  unarchiveSession: (id: string): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.SessionUnarchive, id),
  reactivateSession: (id: string): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.SessionReactivate, id),
  setSessionPinned: (id: string, pinned: boolean): Promise<SessionRecord> =>
    ipcRenderer.invoke(IpcInvoke.SessionSetPinned, id, pinned),
  deleteSession: (id: string): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.SessionDelete, id),
  listEvents: (id: string, limit?: number): Promise<AgentEvent[]> =>
    ipcRenderer.invoke(IpcInvoke.SessionListEvents, id, limit),
  listFileChanges: (id: string): Promise<FileChangeRecord[]> =>
    ipcRenderer.invoke(IpcInvoke.SessionListFileChanges, id),
  getFileFinalDiff: (id: string, filePath: string): Promise<FileFinalDiffResult> =>
    ipcRenderer.invoke(IpcInvoke.SessionGetFileFinalDiff, id, filePath),
  getSessionGitBranch: (id: string): Promise<string | null> =>
    ipcRenderer.invoke(IpcInvoke.SessionGetGitBranch, id),
  listSummaries: (id: string): Promise<SummaryRecord[]> =>
    ipcRenderer.invoke(IpcInvoke.SessionListSummaries, id),
  latestSummaries: (ids: string[]): Promise<Record<string, SummaryRecord>> =>
    ipcRenderer.invoke(IpcInvoke.SessionLatestSummaries, ids),
  listSessionTasks: (id: string): Promise<{ tasks: TaskRecord[] }> =>
    ipcRenderer.invoke(IpcInvoke.SessionListTasks, id),

  handOffPrepare: (
    request: SessionHandOffPrepareRequest,
  ): Promise<SessionHandOffPreparation> =>
    ipcRenderer.invoke(IpcInvoke.SessionHandOffPrepare, request),

  /** Commit deliberately sends only the opaque preparation id. */
  handOffCommit: (preparationId: string): Promise<SessionHandOffCommitResponse> =>
    ipcRenderer.invoke(IpcInvoke.SessionHandOffCommit, preparationId),

  handOffCancel: (preparationId: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcInvoke.SessionHandOffCancel, preparationId),
};
