import type { McpToolPolicy } from '@main/adapters/runtime-profiles';

export function filterAgentDeckTools<T extends { name: string }>(
  tools: readonly T[],
  policy: McpToolPolicy,
): T[] {
  if (policy.kind === 'all') return [...tools];
  const allowed = new Set<string>(policy.tools);
  return tools.filter((tool) => allowed.has(tool.name));
}
