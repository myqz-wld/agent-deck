import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

import type { McpToolPolicy } from '@main/adapters/runtime-profiles';

export function filterAgentDeckTools<T extends Pick<SdkMcpToolDefinition<any>, 'name'>>(
  tools: readonly T[],
  policy: McpToolPolicy,
): T[] {
  if (policy.kind === 'all') return [...tools];
  const allowed = new Set<string>(policy.tools);
  return tools.filter((tool) => allowed.has(tool.name));
}
