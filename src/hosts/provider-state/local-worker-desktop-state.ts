import type { AppSettings } from '@shared/types';

export const LOCAL_WORKER_DESKTOP_STATE_PATH =
  '.agent-deck/local-worker-desktop-state.v1';

export const LOCAL_WORKER_SYNCED_PROVIDER_SETTING_KEYS = Object.freeze([
  'bundledAgentRuntimeOverrides',
  'claudeCodeSandbox',
  'codexSandbox',
  'enableAgentDeckMcp',
  'grokSandbox',
  'injectAgentDeckClaudeAgents',
  'injectAgentDeckClaudeMd',
  'injectAgentDeckClaudeSkills',
  'injectAgentDeckCodexAgents',
  'injectAgentDeckCodexAgentsMd',
  'injectAgentDeckCodexSkills',
  'injectAgentDeckGrokAgents',
  'injectAgentDeckGrokAgentsMd',
  'injectAgentDeckGrokSkills',
  'mcpHttpEnabled',
  'permissionTimeoutMs',
  'summaryModel',
  'summaryThinking',
  'summaryTimeoutMs',
] as const satisfies readonly (keyof AppSettings)[]);
