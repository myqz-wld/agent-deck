/**
 * preload/api/adapters: Adapter 通道相关 IPC facade。
 *
 * 包含会话生命周期（create / interrupt）、消息发送、3 类 pending request 响应
 * （permission / askUserQuestion / exitPlanMode）、permission mode 切换、Codex sandbox
 * next-turn apply、Claude 沙盒冷切，以及 pending request 列表拉取。
 */

import { ipcRenderer } from 'electron';
import { IpcInvoke } from '@shared/ipc-channels';
import type {
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  DiffReviewRequest,
  DiffReviewResponse,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  PermissionRequest,
  PermissionResponse,
  UploadedAttachmentInput,
  PendingOutgoingMessage,
} from '@shared/types';

export const adaptersApi = {
  // Adapter
  listAdapters: (): Promise<{ id: string; displayName: string; capabilities: Record<string, boolean> }[]> =>
    ipcRenderer.invoke(IpcInvoke.AdapterList),
  createAdapterSession: (agentId: string, opts: Record<string, unknown>): Promise<string> =>
    ipcRenderer.invoke(IpcInvoke.AdapterCreateSession, agentId, opts),
  interruptAdapterSession: (agentId: string, sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.AdapterInterrupt, agentId, sessionId),
  sendAdapterMessage: (
    agentId: string,
    sessionId: string,
    payload: string | { text: string; attachments?: UploadedAttachmentInput[] },
  ): Promise<{ messageId: string; sessionId: string }> =>
    ipcRenderer.invoke(IpcInvoke.AdapterSendMessage, agentId, sessionId, payload),
  listPendingOutgoingMessages: (
    agentId: string,
    sessionId: string,
  ): Promise<PendingOutgoingMessage[]> =>
    ipcRenderer.invoke(IpcInvoke.AdapterListPendingOutgoing, agentId, sessionId),
  deletePendingOutgoingMessage: (
    agentId: string,
    sessionId: string,
    messageId: string,
  ): Promise<boolean> =>
    ipcRenderer.invoke(IpcInvoke.AdapterDeletePendingOutgoing, agentId, sessionId, messageId),
  steerAdapterTurn: (
    agentId: string,
    sessionId: string,
    text: string,
  ): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.AdapterSteerTurn, agentId, sessionId, text),
  respondPermission: (
    agentId: string,
    sessionId: string,
    requestId: string,
    response: PermissionResponse,
  ): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.AdapterRespondPermission, agentId, sessionId, requestId, response),
  respondAskUserQuestion: (
    agentId: string,
    sessionId: string,
    requestId: string,
    answer: AskUserQuestionAnswer,
  ): Promise<void> =>
    ipcRenderer.invoke(
      IpcInvoke.AdapterRespondAskUserQuestion,
      agentId,
      sessionId,
      requestId,
      answer,
    ),
  respondExitPlanMode: (
    agentId: string,
    sessionId: string,
    requestId: string,
    response: ExitPlanModeResponse,
  ): Promise<{ resolvedSessionId: string }> =>
    ipcRenderer.invoke(
      IpcInvoke.AdapterRespondExitPlanMode,
      agentId,
      sessionId,
      requestId,
      response,
    ),
  respondDiffReview: (
    agentId: string,
    sessionId: string,
    requestId: string,
    response: DiffReviewResponse,
  ): Promise<void> =>
    ipcRenderer.invoke(
      IpcInvoke.AdapterRespondDiffReview,
      agentId,
      sessionId,
      requestId,
      response,
    ),
  setAdapterPermissionMode: (
    agentId: string,
    sessionId: string,
    mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions',
  ): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.AdapterSetPermissionMode, agentId, sessionId, mode),
  setSessionModelOptions: (
    agentId: string,
    sessionId: string,
    options: { model: string | null; thinking: string | null },
  ): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.AdapterSetSessionModelOptions, agentId, sessionId, options),

  /**
   * Codex sandbox 切换。IPC 名称沿用 restartWithCodexSandbox 兼容旧调用方；app-server
   * Codex 实现不再销毁/重建 thread，而是持久化新档位并让下一次 turn/start 使用新 sandbox。
   * 失败时主进程已 emit error message + 回滚 sessionRepo.codexSandbox，本接口仅 throw 让 UI catch。
   */
  restartWithCodexSandbox: (
    agentId: string,
    sessionId: string,
    sandbox: 'workspace-write' | 'read-only' | 'danger-full-access',
    handoffPrompt: string,
  ): Promise<string> =>
    ipcRenderer.invoke(
      IpcInvoke.AdapterRestartWithCodexSandbox,
      agentId,
      sessionId,
      sandbox,
      handoffPrompt,
    ),

  /**
   * Claude Code OS 沙盒冷切（CHANGELOG_74）。
   * SDK 的 sandbox options 是 query() spawn-time 锁定，运行时切档必须冷切（销毁旧 SDK
   * 子进程 + 用新档位 createSession resume 重建）。adapter 必须
   * capabilities.canRestartWithClaudeCodeSandbox === true。失败回滚 sessionRepo.claudeCodeSandbox。
   */
  restartWithClaudeCodeSandbox: (
    agentId: string,
    sessionId: string,
    sandbox: 'off' | 'workspace-write' | 'strict',
    handoffPrompt: string,
  ): Promise<string> =>
    ipcRenderer.invoke(
      IpcInvoke.AdapterRestartWithClaudeCodeSandbox,
      agentId,
      sessionId,
      sandbox,
      handoffPrompt,
    ),

  /** 拉取主进程 SDK 当前还在等的 pending 请求；renderer HMR / 重启后用来重建 store。 */
  listAdapterPending: (
    agentId: string,
    sessionId: string,
  ): Promise<{
    permissions: PermissionRequest[];
    askQuestions: AskUserQuestionRequest[];
    exitPlanModes: ExitPlanModeRequest[];
    diffReviews: DiffReviewRequest[];
  }> => ipcRenderer.invoke(IpcInvoke.AdapterListPending, agentId, sessionId),
  listAdapterPendingAll: (
    agentId: string,
  ): Promise<
    Record<
      string,
      {
        permissions: PermissionRequest[];
        askQuestions: AskUserQuestionRequest[];
        exitPlanModes: ExitPlanModeRequest[];
        diffReviews?: DiffReviewRequest[];
      }
    >
  > => ipcRenderer.invoke(IpcInvoke.AdapterListPendingAll, agentId),
};
