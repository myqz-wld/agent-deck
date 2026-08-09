import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_DECK_MCP_TOOL_PATTERN } from '@main/agent-deck-mcp/server';

import {
  buildClaudeQueryOptionsCore,
  type BuildClaudeQueryOptionsCoreArgs,
} from './query-options-builder-core';

export type BuildClaudeQueryOptionsArgs = Omit<
  BuildClaudeQueryOptionsCoreArgs,
  'agentDeckMcpToolPattern'
>;

/** Stable desktop facade that supplies the app-owned MCP namespace to the host-neutral builder. */
export function buildClaudeQueryOptions(
  args: BuildClaudeQueryOptionsArgs,
): Options {
  return buildClaudeQueryOptionsCore({
    ...args,
    agentDeckMcpToolPattern: AGENT_DECK_MCP_TOOL_PATTERN,
  });
}
