/** Preload facade for runtime sessions, messages, controls, and pending requests. */

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
  AdapterSessionMode,
  CodexApprovalPolicy,
  SessionCreationConfiguration,
  SessionCommandDescriptor,
  SelectablePermissionMode,
} from '@shared/types';

export const adaptersApi = {
  listAdapters: (): Promise<Array<{
    id: string;
    displayName: string;
    capabilities: Record<string, boolean>;
    sessionModes: AdapterSessionMode[];
  }>> =>
    ipcRenderer.invoke(IpcInvoke.AdapterList),
  createAdapterSession: (agentId: string, opts: Record<string, unknown>): Promise<string> =>
    ipcRenderer.invoke(IpcInvoke.AdapterCreateSession, agentId, opts),
  getAdapterSessionCreationDefaults: (
    agentId: string,
    options: { cwd?: string; provider?: string } = {},
  ): Promise<SessionCreationConfiguration> =>
    ipcRenderer.invoke(IpcInvoke.AdapterSessionCreationDefaults, agentId, options),
  interruptAdapterSession: (agentId: string, sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.AdapterInterrupt, agentId, sessionId),
  sendAdapterMessage: (
    agentId: string,
    sessionId: string,
    payload: string | { text: string; attachments?: UploadedAttachmentInput[] },
  ): Promise<{ messageId: string; sessionId: string }> =>
    ipcRenderer.invoke(IpcInvoke.AdapterSendMessage, agentId, sessionId, payload),
  listAdapterSessionCommands: (
    agentId: string,
    sessionId: string,
  ): Promise<SessionCommandDescriptor[]> =>
    ipcRenderer.invoke(IpcInvoke.AdapterListSessionCommands, agentId, sessionId),
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
    mode: SelectablePermissionMode,
  ): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.AdapterSetPermissionMode, agentId, sessionId, mode),
  setAdapterSessionMode: (
    agentId: string,
    sessionId: string,
    mode: AdapterSessionMode,
  ): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.AdapterSetSessionMode, agentId, sessionId, mode),
  setSessionModelOptions: (
    agentId: string,
    sessionId: string,
    options: { provider: string | null; model: string | null; thinking: string | null },
  ): Promise<void> =>
    ipcRenderer.invoke(IpcInvoke.AdapterSetSessionModelOptions, agentId, sessionId, options),

  /**
   * Persist a Codex approval policy and apply it to the next app-server turn. The active turn is
   * not interrupted; failures roll the session record and live thread options back.
   */
  setCodexApprovalPolicy: (
    agentId: string,
    sessionId: string,
    policy: CodexApprovalPolicy,
  ): Promise<void> =>
    ipcRenderer.invoke(
      IpcInvoke.AdapterSetCodexApprovalPolicy,
      agentId,
      sessionId,
      policy,
    ),

  /** Persist the Codex sandbox selection for the next round without interrupting this one. */
  setCodexSandbox: (
    agentId: string,
    sessionId: string,
    sandbox: 'workspace-write' | 'read-only' | 'danger-full-access',
  ): Promise<void> =>
    ipcRenderer.invoke(
      IpcInvoke.AdapterSetCodexSandbox,
      agentId,
      sessionId,
      sandbox,
    ),

  /** Restart an idle Claude Code child because its OS sandbox is fixed at spawn time. */
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

  /** Restart an idle Grok ACP child with a requested native sandbox profile. */
  restartWithGrokSandbox: (
    agentId: string,
    sessionId: string,
    sandbox: string | null,
  ): Promise<string> =>
    ipcRenderer.invoke(
      IpcInvoke.AdapterRestartWithGrokSandbox,
      agentId,
      sessionId,
      sandbox,
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
