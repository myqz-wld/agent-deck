/**
 * preload/api/sessions: 会话相关 IPC facade。
 *
 * 包含会话 CRUD / 历史查询 / 子表（events / file_changes / summaries）拉取，以及
 * K3 hand-off 两阶段（summarize + spawn）。
 */

import { ipcRenderer } from 'electron';
import { IpcInvoke } from '@shared/ipc-channels';
import type {
  AgentEvent,
  FileFinalDiffResult,
  FileChangeRecord,
  HandOffPreview,
  HandOffSpawnRequest,
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

  /**
   * Stage 1：在稳定事件边界内生成六节压缩检查点，并与最近原始对话和当前续接指令
   * 组成可编辑 capsule。LLM 失败时可降级保留 raw；没有任何可接力历史时才 throw。
   */
  handOffSummarize: (sessionId: string): Promise<HandOffPreview> =>
    ipcRenderer.invoke(IpcInvoke.SessionHandOffSummarize, sessionId),

  /**
   * Stage 2：用已审阅 capsule 和所选 adapter / model / thinking 起新 SDK session，迁移
   * session-owned resources 后关闭并归档源 session。
   * spawn 成功后 main 端 emit session-focus-request 自动切 detail 到新 session。
   */
  handOffSpawn: (sessionId: string, request: HandOffSpawnRequest): Promise<string> =>
    ipcRenderer.invoke(IpcInvoke.SessionHandOffSpawn, sessionId, request),
};
