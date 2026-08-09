import {
  ClaudeCodeAdapter,
  type ClaudeCodeAdapterHost,
} from './claude-code/adapter-core';
import {
  CodexCliAdapter,
  type CodexCliAdapterHost,
} from './codex-cli/adapter-core';
import {
  GrokBuildAdapter,
  type GrokBuildAdapterHost,
} from './grok-build/adapter-core';
import type { AgentAdapter } from './types';

export interface ProviderAdapterSetHosts {
  readonly claude: ClaudeCodeAdapterHost;
  readonly codex: CodexCliAdapterHost;
  readonly grok: GrokBuildAdapterHost;
}

export interface ProviderAdapterSet {
  readonly claude: ClaudeCodeAdapter;
  readonly codex: CodexCliAdapter;
  readonly grok: GrokBuildAdapter;
  readonly adapters: readonly AgentAdapter[];
}

/** Constructs one isolated provider set from explicit hosts and no desktop singleton discovery. */
export function createProviderAdapterSet(
  hosts: ProviderAdapterSetHosts,
): ProviderAdapterSet {
  const claude = new ClaudeCodeAdapter(hosts.claude);
  const codex = new CodexCliAdapter(hosts.codex);
  const grok = new GrokBuildAdapter(hosts.grok);
  return Object.freeze({
    claude,
    codex,
    grok,
    adapters: Object.freeze([claude, codex, grok]),
  });
}
