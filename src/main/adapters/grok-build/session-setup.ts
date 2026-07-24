import type { McpServer } from '@agentclientprotocol/sdk';
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';

import type { GrokRuntime } from './runtime-types';

export interface GrokSessionSetupOptions {
  mcpHttpUrl: string;
  isAgentDeckMcpEnabled: () => boolean;
  getAgentProfilePrompt: () => Promise<string | null>;
  getPluginDirectories: (options: { requiresAgent: boolean }) => Promise<string[]>;
}

export async function buildGrokSessionMeta(
  runtime: GrokRuntime,
  options: GrokSessionSetupOptions,
): Promise<Record<string, unknown>> {
  const [promptBody, pluginDirs] = await Promise.all([
    options.getAgentProfilePrompt(),
    options.getPluginDirectories({
      requiresAgent: runtime.agentProfileName !== null,
    }),
  ]);
  return {
    ...(runtime.agentProfileName
      ? { agentProfile: runtime.agentProfileName }
      : promptBody
        ? {
            agentProfile: {
              name: 'agent-deck',
              description: 'Agent Deck runtime integration',
              promptMode: 'extend',
              promptBody,
            },
          }
        : {}),
    ...(pluginDirs.length ? { pluginDirs } : {}),
    ...(runtime.model ? { modelId: runtime.model } : {}),
    ...(runtime.thinking ? { reasoningEffort: runtime.thinking } : {}),
  };
}

export function buildGrokMcpServers(
  applicationSessionId: string,
  options: GrokSessionSetupOptions,
): McpServer[] {
  if (!options.isAgentDeckMcpEnabled()) return [];
  const token = mcpSessionTokenMap.allocate(applicationSessionId);
  return [
    {
      type: 'http',
      name: 'agent-deck',
      url: options.mcpHttpUrl,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    },
  ];
}
