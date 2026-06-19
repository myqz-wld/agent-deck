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
   * K3 hand-off Stage 1 (plan mcp-bug-and-feature-batch-20260513 Phase 4c)：拉历史 →
   * LLM oneshot 生成结构化「目标 / 已做 / 下一步 / 相关文件」接力简报。返回供 renderer
   * 在 modal preview / 编辑后再调 handOffSpawn 起新 session。
   * 失败：throw → renderer modal 显示 inline error 让用户重试。
   */
  handOffSummarize: (
    sessionId: string,
  ): Promise<{
    summary: string;
    sourceCwd: string;
    sourceAgentId: string;
    sourcePermissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | null;
  }> => ipcRenderer.invoke(IpcInvoke.SessionHandOffSummarize, sessionId),

  /**
   * K3 hand-off Stage 2：用 finalPrompt（modal 可能已编辑）起新 SDK session（adapter / cwd /
   * permissionMode 沿用原 session）+ 自动归档原 session（archive 失败仅 warn 不阻塞）。
   * spawn 成功后 main 端 emit session-focus-request 自动切 detail 到新 session。
   */
  handOffSpawn: (sessionId: string, finalPrompt: string): Promise<string> =>
    ipcRenderer.invoke(IpcInvoke.SessionHandOffSpawn, sessionId, finalPrompt),
};
