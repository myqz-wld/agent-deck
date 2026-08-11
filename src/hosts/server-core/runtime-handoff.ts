import type {
  SessionHandOffCommitResult,
  SessionHandOffPreviewParams,
} from '@contracts/index';
import type { HandOffSessionResult } from '@main/agent-deck-mcp/tools/schemas';

import type { ServerCoreHandOffSessionArgs } from './mcp-handoff-port';

export function serverCoreHandOffArgs(
  params: SessionHandOffPreviewParams,
): ServerCoreHandOffSessionArgs {
  const { adapterId, options, workingDirectory } = params.target;
  return {
    prompt: params.continuationInstruction,
    ...(workingDirectory ? { cwd: workingDirectory } : {}),
    ...(params.target.capabilityRevision
      ? { capabilityRevision: params.target.capabilityRevision }
      : {}),
    adapter: adapterId,
    ...(adapterId === 'claude-code' && options.provider
      ? { gateway: options.provider }
      : {}),
    ...(adapterId === 'codex-cli' && options.provider
      ? { provider: options.provider }
      : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.thinking ? { thinking: options.thinking } : {}),
    ...(adapterId === 'claude-code' && options.permissionMode
      ? { permissionMode: options.permissionMode }
      : {}),
    ...(adapterId === 'codex-cli' && options.approvalPolicy
      ? { approvalPolicy: options.approvalPolicy }
      : {}),
    ...(adapterId === 'grok-build' && options.sessionMode
      ? { sessionMode: options.sessionMode }
      : {}),
    ...(adapterId === 'claude-code' && options.claudeCodeSandbox
      ? { claudeCodeSandbox: options.claudeCodeSandbox }
      : {}),
    ...(adapterId === 'codex-cli' && options.codexSandbox
      ? { codexSandbox: options.codexSandbox }
      : {}),
    ...(adapterId === 'grok-build' && options.grokSandbox
      ? { grokSandbox: options.grokSandbox }
      : {}),
  };
}

export function serverCoreHandOffCommitResult(
  result: HandOffSessionResult,
  revision: number,
): SessionHandOffCommitResult {
  return {
    successorSessionId: result.sessionId,
    cutoverEventRevision: result.continuationContext.cutoverEventRevision,
    lateMessagesDelivered: result.continuationContext.lateMessagesDelivered,
    usedLowerBudgetRetry: result.continuationContext.usedLowerBudgetRetry,
    sourceFinalizationWarning: result.callerClosed === 'ok'
      ? null
      : '新会话已创建，但源会话的提供方收尾未能完全确认。',
    revision,
  };
}
