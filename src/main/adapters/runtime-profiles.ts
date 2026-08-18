import type { AgentDeckToolName } from '@main/agent-deck-mcp/types';
import {
  PERMISSION_MODES,
  type SelectablePermissionMode,
} from '@shared/types';
import type {
  AdapterSessionMode,
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
    permissionModes: readonly SelectablePermissionMode[];
    sessionModes: readonly AdapterSessionMode[];
    /** Provider selector exposed at session creation, when the provider supports one. */
    providerOverride: 'claude-gateway' | 'codex-gateway' | 'none';
    /** Provider-native sandbox family. */
    sandbox: 'claude' | 'codex' | 'grok';
    /** Whether a session may add writable roots outside cwd. */
    extraAllowWrite: boolean;
  };
  mcpTools: McpToolPolicy;
  /**
   * Local legacy Browser MCP registration. Unified interactive sessions use the bundled Browser
   * skill plus `agent-deck-browser`, so every local adapter must keep this false. Server Core owns
   * its separately staged Remote compatibility surface.
   */
  mcpBrowserTools: boolean;
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
      canSetCodexApprovalPolicy: false,
      canSetSessionMode: false,
      canRestartWithPermissionMode: true,
      canSetCodexSandbox: false,
      canRestartWithClaudeCodeSandbox: true,
      canRestartWithGrokSandbox: false,
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
      permissionModes: PERMISSION_MODES,
      sessionModes: [],
      providerOverride: 'claude-gateway',
      sandbox: 'claude',
      extraAllowWrite: true,
    },
    mcpTools: { kind: 'all' },
    mcpBrowserTools: false,
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
      canRespondPermission: true,
      canSetPermissionMode: false,
      canSetCodexApprovalPolicy: true,
      canSetSessionMode: false,
      canRestartWithPermissionMode: false,
      canSetCodexSandbox: true,
      canRestartWithClaudeCodeSandbox: false,
      canRestartWithGrokSandbox: false,
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
      providerOverride: 'codex-gateway',
      sandbox: 'codex',
      extraAllowWrite: true,
    },
    mcpTools: { kind: 'all' },
    mcpBrowserTools: false,
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
      canSteerTurn: true,
      canInstallHooks: true,
      canRespondPermission: true,
      canSetPermissionMode: false,
      canSetCodexApprovalPolicy: false,
      canSetSessionMode: true,
      canRestartWithPermissionMode: false,
      canSetCodexSandbox: false,
      canRestartWithClaudeCodeSandbox: false,
      canRestartWithGrokSandbox: true,
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
      providerOverride: 'none',
      sandbox: 'grok',
      extraAllowWrite: false,
    },
    mcpTools: { kind: 'all' },
    mcpBrowserTools: false,
  },
} satisfies Record<SessionAdapterId, AdapterRuntimeProfile>;

export function getAdapterRuntimeProfile(adapterId: SessionAdapterId): AdapterRuntimeProfile {
  return profiles[adapterId];
}

export function isSessionAdapterId(value: string): value is SessionAdapterId {
  return Object.hasOwn(profiles, value);
}
