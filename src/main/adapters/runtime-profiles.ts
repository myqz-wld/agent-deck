import type { AgentDeckToolName } from '@main/agent-deck-mcp/types';
import type {
  AdapterSessionMode,
  PermissionMode,
  SessionAdapterId,
} from '@shared/types';

import type { AdapterCapabilities } from './types';

export type PromptInjectionKind =
  | 'claude-system-prompt-append'
  | 'codex-developer-instructions'
  | 'grok-acp-agent-profile';

export type McpToolPolicy =
  | { kind: 'all' }
  | { kind: 'allow'; tools: readonly AgentDeckToolName[] };

export interface AdapterRuntimeProfile {
  id: SessionAdapterId;
  displayName: string;
  capabilities: AdapterCapabilities;
  prompt: {
    injection: PromptInjectionKind;
    bundledResourceRoot: 'claude-config' | 'codex-config' | 'grok-config';
  };
  nativeTools: {
    policy: 'provider-defaults';
  };
  model: {
    thinkingLevels: readonly string[];
  };
  runtimeControls: {
    permissionModes: readonly PermissionMode[];
    sessionModes: readonly AdapterSessionMode[];
  };
  mcpTools: McpToolPolicy;
}

const profiles = {
  'claude-code': {
    id: 'claude-code',
    displayName: 'Claude Code',
    capabilities: {
      canCreateSession: true,
      canSetSessionModelOptions: true,
      canForkSession: true,
      canInterrupt: true,
      canSendMessage: true,
      canInstallHooks: true,
      canRespondPermission: true,
      canSetPermissionMode: true,
      canSetSessionMode: false,
      canRestartWithPermissionMode: true,
      canRestartWithCodexSandbox: false,
      canRestartWithClaudeCodeSandbox: true,
      canCloseSession: true,
      canCollaborate: true,
      canAcceptAttachments: true,
    },
    prompt: {
      injection: 'claude-system-prompt-append',
      bundledResourceRoot: 'claude-config',
    },
    nativeTools: { policy: 'provider-defaults' },
    model: {
      thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    runtimeControls: {
      permissionModes: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
      sessionModes: [],
    },
    mcpTools: { kind: 'all' },
  },
  'deepseek-claude-code': {
    id: 'deepseek-claude-code',
    displayName: 'Deepseek (Claude Code)',
    capabilities: {
      canCreateSession: true,
      canSetSessionModelOptions: true,
      canForkSession: true,
      canInterrupt: true,
      canSendMessage: true,
      canInstallHooks: false,
      canRespondPermission: true,
      canSetPermissionMode: true,
      canSetSessionMode: false,
      canRestartWithPermissionMode: true,
      canRestartWithCodexSandbox: false,
      canRestartWithClaudeCodeSandbox: true,
      canCloseSession: true,
      canCollaborate: true,
      canAcceptAttachments: true,
    },
    prompt: {
      injection: 'claude-system-prompt-append',
      bundledResourceRoot: 'claude-config',
    },
    nativeTools: { policy: 'provider-defaults' },
    model: {
      thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    runtimeControls: {
      permissionModes: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
      sessionModes: [],
    },
    mcpTools: { kind: 'all' },
  },
  'codex-cli': {
    id: 'codex-cli',
    displayName: 'Codex CLI',
    capabilities: {
      canCreateSession: true,
      canSetSessionModelOptions: true,
      canForkSession: true,
      canInterrupt: true,
      canSendMessage: true,
      canSteerTurn: true,
      canInstallHooks: true,
      canRespondPermission: false,
      canSetPermissionMode: false,
      canSetSessionMode: false,
      canRestartWithPermissionMode: false,
      canRestartWithCodexSandbox: true,
      canRestartWithClaudeCodeSandbox: false,
      canCloseSession: true,
      canCollaborate: true,
      canAcceptAttachments: true,
    },
    prompt: {
      injection: 'codex-developer-instructions',
      bundledResourceRoot: 'codex-config',
    },
    nativeTools: { policy: 'provider-defaults' },
    model: {
      thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    },
    runtimeControls: {
      permissionModes: [],
      sessionModes: [],
    },
    mcpTools: { kind: 'all' },
  },
  'grok-build': {
    id: 'grok-build',
    displayName: 'Grok Build',
    capabilities: {
      canCreateSession: true,
      canSetSessionModelOptions: true,
      canForkSession: false,
      canInterrupt: true,
      canSendMessage: true,
      canInstallHooks: false,
      canRespondPermission: true,
      canSetPermissionMode: false,
      canSetSessionMode: true,
      canRestartWithPermissionMode: false,
      canRestartWithCodexSandbox: false,
      canRestartWithClaudeCodeSandbox: false,
      canCloseSession: true,
      canCollaborate: true,
      // Updated from ACP initialize during adapter init.
      canAcceptAttachments: false,
    },
    prompt: {
      injection: 'grok-acp-agent-profile',
      bundledResourceRoot: 'grok-config',
    },
    nativeTools: { policy: 'provider-defaults' },
    model: {
      thinkingLevels: ['low', 'medium', 'high', 'xhigh'],
    },
    runtimeControls: {
      permissionModes: [],
      sessionModes: ['default', 'plan', 'ask'],
    },
    mcpTools: { kind: 'all' },
  },
} satisfies Record<SessionAdapterId, AdapterRuntimeProfile>;

export function getAdapterRuntimeProfile(adapterId: SessionAdapterId): AdapterRuntimeProfile {
  return profiles[adapterId];
}

export function isSessionAdapterId(value: string): value is SessionAdapterId {
  return Object.hasOwn(profiles, value);
}
