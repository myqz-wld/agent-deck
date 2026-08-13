import type { SessionConsoleCreateParams } from '@contracts/index';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { buildCreateSessionOptions } from '@main/adapters/options-builder';
import type { InitialSessionRegistration } from '@main/adapters/types';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
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

export type ServerCoreAgentCreateOptions =
  | {
      readonly adapterId: 'claude-code';
      readonly claudeAgentName: string;
      readonly claudeAgents: Record<string, AgentDefinition>;
    }
  | {
      readonly adapterId: 'codex-cli';
      readonly developerInstructions: string;
      readonly codexConfigOverrides: CodexConfigObject;
    }
  | {
      readonly adapterId: 'grok-build';
      readonly grokAgentName: string;
      readonly grokAgentSource: 'bundled';
    };

export interface ServerCoreInternalCreateOptions {
  readonly awaitCanonicalId?: boolean;
  readonly initialSessionRegistration?: InitialSessionRegistration;
  readonly teamName?: string;
  readonly agent?: ServerCoreAgentCreateOptions;
}

function commonInternal(internal: ServerCoreInternalCreateOptions) {
  return {
    ...(internal.awaitCanonicalId === undefined
      ? {}
      : { awaitCanonicalId: internal.awaitCanonicalId }),
    ...(internal.initialSessionRegistration === undefined
      ? {}
      : { initialSessionRegistration: internal.initialSessionRegistration }),
    ...(internal.teamName === undefined ? {} : { teamName: internal.teamName }),
  };
}

export function buildRemoteCreateOptions(
  params: SessionConsoleCreateParams,
  cwd: string,
  attachments: UploadedAttachmentRef[],
  internal: ServerCoreInternalCreateOptions = {},
) {
  const options = params.options;
  const common = commonInternal(internal);
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
      ...common,
      ...(internal.agent?.adapterId === 'claude-code' ? {
        claudeAgentName: internal.agent.claudeAgentName,
        claudeAgents: internal.agent.claudeAgents,
      } : {}),
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
      ...common,
      ...(internal.agent?.adapterId === 'codex-cli' ? {
        developerInstructions: internal.agent.developerInstructions,
        codexConfigOverrides: internal.agent.codexConfigOverrides,
      } : {}),
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
    ...common,
    ...(internal.agent?.adapterId === 'grok-build' ? {
      grokAgentName: internal.agent.grokAgentName,
      grokAgentSource: internal.agent.grokAgentSource,
    } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  });
}
