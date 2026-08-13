import type { SessionConsoleCreateParams } from '@contracts/index';
import { buildCreateSessionOptions } from '@main/adapters/options-builder';
import type { InitialSessionRegistration } from '@main/adapters/types';
import {
  isAdapterSessionMode,
  isCodexApprovalPolicy,
  isSelectablePermissionMode,
  type UploadedAttachmentRef,
} from '@shared/types';
import {
  isClaudeThinkingLevel,
  isCodexThinkingLevel,
  isGrokThinkingLevel,
} from '@shared/session-metadata';

export function buildRemoteCreateOptions(
  params: SessionConsoleCreateParams,
  cwd: string,
  attachments: UploadedAttachmentRef[],
  internal: {
    readonly awaitCanonicalId?: boolean;
    readonly initialSessionRegistration?: InitialSessionRegistration;
    readonly teamName?: string;
  } = {},
) {
  const options = params.options;
  if (params.adapterId === 'claude-code') {
    if (
      !isSelectablePermissionMode(options.permissionMode) ||
      !isClaudeThinkingLevel(options.thinking) ||
      !['off', 'workspace-write', 'strict'].includes(options.claudeCodeSandbox ?? '')
    ) throw new Error('Validated Claude create options are inconsistent');
    return buildCreateSessionOptions('claude-code', {
      cwd,
      prompt: params.initialMessage,
      ...(options.provider ? { gateway: options.provider } : {}),
      ...(options.model ? { model: options.model } : {}),
      claudeCodeEffortLevel: options.thinking,
      permissionMode: options.permissionMode,
      claudeCodeSandbox: options.claudeCodeSandbox as 'off' | 'workspace-write' | 'strict',
      ...internal,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  }
  if (params.adapterId === 'codex-cli') {
    if (
      !isCodexApprovalPolicy(options.approvalPolicy) ||
      !isCodexThinkingLevel(options.thinking) ||
      !['workspace-write', 'read-only', 'danger-full-access'].includes(options.codexSandbox ?? '')
    ) throw new Error('Validated Codex create options are inconsistent');
    return buildCreateSessionOptions('codex-cli', {
      cwd,
      prompt: params.initialMessage,
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { model: options.model } : {}),
      modelReasoningEffort: options.thinking,
      approvalPolicy: options.approvalPolicy,
      codexSandbox: options.codexSandbox as 'workspace-write' | 'read-only' | 'danger-full-access',
      ...internal,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  }
  if (
    params.adapterId !== 'grok-build' || !isAdapterSessionMode(options.sessionMode) ||
    !isGrokThinkingLevel(options.thinking) ||
    !['read-only', 'workspace', 'off'].includes(options.grokSandbox ?? '')
  ) throw new Error('Validated Grok create options are inconsistent');
  return buildCreateSessionOptions('grok-build', {
    cwd,
    prompt: params.initialMessage,
    ...(options.model ? { model: options.model } : {}),
    reasoningEffort: options.thinking,
    sessionMode: options.sessionMode,
    grokSandbox: options.grokSandbox,
    ...internal,
    ...(attachments.length > 0 ? { attachments } : {}),
  });
}
