/**
 * preload/api/issues: Issue Tracker IPC facade (plan issue-tracker-mcp-20260529 §Step 3.5.2)。
 *
 * 6 个 channel 给 UI Issues tab 用（agent 不消费 — mcp tool report_issue / append_issue_context
 * 走 mcp transport 不走 IPC）。
 *
 * **§D14 选定路径 (b)**: resolveInNewSession 走 IPC handler 内 adapter.createSession(buildCreateSessionOptions)
 * adapter 层 API（绕 mcp tool 层 spawn-guards），起独立 SDK session + 回写 resolutionSessionId +
 * status='in-progress'。
 */

import { ipcRenderer } from 'electron';
import { IpcInvoke } from '@shared/ipc-channels';
import type { IssueRecord } from '@shared/types';
import type { SessionThinkingLevel } from '@shared/session-metadata';

export interface IssuesListFilters {
  statuses?: Array<'open' | 'in-progress' | 'resolved'>;
  kinds?: string[];
  titleKeyword?: string;
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface IssuesUpdatePatch {
  title?: string;
  description?: string;
  repro?: string | null;
  kind?: string;
  /** §D7 严格 enum (zod IPC handler 层校验) */
  status?: 'open' | 'in-progress' | 'resolved';
  severity?: 'low' | 'medium' | 'high';
  labels?: string[];
}

export interface IssuesResolveInNewSessionArgs {
  issueId: string;
  adapter: string;
  /** optional — handler 内 fallback: args.cwd > issue.cwd > homedir */
  cwd?: string;
  /** D8 模板预填（含 title / description / repro / logsRef / appendices null fallback 整段省略） */
  prompt: string;
  /** optional — adapter 默认 + settings 白名单 */
  permissionMode?: string;
  codexSandbox?: string;
  claudeCodeSandbox?: string;
  /** optional — 空值不传，使用目标 provider 默认模型。 */
  model?: string;
  /** optional — adapter-aware 档位；空值不传，使用目标 provider 默认值。 */
  thinking?: SessionThinkingLevel;
}

export interface IssuesResolveInNewSessionResult {
  sessionId: string;
  issue: IssueRecord;
}

export const issuesApi = {
  /** §IssuesList: 列表 + filter（statuses/kinds/titleKeyword/includeDeleted/onlyDeleted/limit/offset） */
  issuesList: (filters?: IssuesListFilters): Promise<IssueRecord[]> =>
    ipcRenderer.invoke(IpcInvoke.IssuesList, filters),
  /** §IssuesGet: detail 视图（拼 appendices 子列表） */
  issuesGet: (id: string): Promise<IssueRecord | null> =>
    ipcRenderer.invoke(IpcInvoke.IssuesGet, id),
  /** §IssuesUpdate: zod enum 严格校验 status (§D7) + repo 状态机走 D15 transition */
  issuesUpdate: (id: string, patch: IssuesUpdatePatch): Promise<IssueRecord> =>
    ipcRenderer.invoke(IpcInvoke.IssuesUpdate, id, patch),
  /** §IssuesSoftDelete: 写 deletedAt; idempotent (已 soft-deleted 返 false) */
  issuesSoftDelete: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcInvoke.IssuesSoftDelete, id),
  /** §IssuesUndelete: 清 deletedAt; idempotent (未 soft-deleted 返 false) */
  issuesUndelete: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcInvoke.IssuesUndelete, id),
  /**
   * §IssuesResolveInNewSession: 起独立 SDK session + 回写 resolutionSessionId + status='in-progress'
   * (§D8 + §D14 选定路径 (b))。in-flight Promise dedupe 兜底 React 双 click race。
   */
  issuesResolveInNewSession: (
    args: IssuesResolveInNewSessionArgs,
  ): Promise<IssuesResolveInNewSessionResult> =>
    ipcRenderer.invoke(IpcInvoke.IssuesResolveInNewSession, args),
};
