import { isAgentId } from '@main/adapters/options-builder';
import { adapterRegistry } from '@main/adapters/registry';
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import { sessionManager } from '@main/session/manager';
import type { SessionRecord } from '@shared/types';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Finalize a committed MCP handoff without interrupting the turn that must return its tool result.
 * Every revocation step is independent: ownership has already moved, so one cleanup failure must
 * never leave the old token or provider runtime live merely by short-circuiting later steps.
 */
export function finalizeMcpHandOffSource(source: SessionRecord): void {
  const failures: string[] = [];
  try {
    sessionManager.markClosed(source.id);
  } catch (error) {
    failures.push(`mark closed failed: ${errorText(error)}`);
  }
  try {
    mcpSessionTokenMap.release(source.id);
  } catch (error) {
    failures.push(`token release failed: ${errorText(error)}`);
  }
  try {
    if (isAgentId(source.agentId)) {
      adapterRegistry.get(source.agentId)?.retireSessionAfterCurrentTurn?.(source.id);
    }
  } catch (error) {
    failures.push(`runtime retirement failed: ${errorText(error)}`);
  }
  if (failures.length > 0) throw new Error(failures.join('; '));
}
