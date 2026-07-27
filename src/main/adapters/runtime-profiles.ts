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
    providerOverride: 'claude-gateway' | 'codex-model-provider' | 'none';
    /** Provider-native sandbox family. `provider-native` has no Agent Deck sandbox override. */
    sandbox: 'claude' | 'codex' | 'provider-native';
    /** Whether a session may add writable roots outside cwd. */
    extraAllowWrite: boolean;
  };
  mcpTools: McpToolPolicy;
  /**
   * Whether Agent Deck's own in-app browser is exposed to this adapter as `browser_*` MCP tools
   * (plan cross-adapter-browser-engine-20260727).
   *
   * False for Codex CLI on purpose: Codex sessions drive the same engine through the official
   * Browser plugin over the native pipe (`src/main/browser-use/fronts/codex-pipe.ts`), and two
   * competing browser surfaces in one session only make the model choose badly. Everything else
   * about the browser — engine, isolation, disposal — is shared.
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
      permissionModes: PERMISSION_MODES,
      sessionModes: [],
      providerOverride: 'claude-gateway',
      sandbox: 'claude',
      extraAllowWrite: true,
    },
    mcpTools: { kind: 'all' },
    mcpBrowserTools: true,
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
      providerOverride: 'codex-model-provider',
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
      providerOverride: 'none',
      sandbox: 'provider-native',
      extraAllowWrite: false,
    },
    mcpTools: { kind: 'all' },
    mcpBrowserTools: true,
  },
} satisfies Record<SessionAdapterId, AdapterRuntimeProfile>;

export function getAdapterRuntimeProfile(adapterId: SessionAdapterId): AdapterRuntimeProfile {
  return profiles[adapterId];
}

export function isSessionAdapterId(value: string): value is SessionAdapterId {
  return Object.hasOwn(profiles, value);
}
