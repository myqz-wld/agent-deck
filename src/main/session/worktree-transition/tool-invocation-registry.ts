import type { AgentEvent } from '@shared/types';
import type { WorktreeTransitionDirection } from './types';

const TOOL_PREFIX = 'mcp__agent-deck__';
const REGISTRATION_TTL_MS = 5 * 60_000;

interface ToolInvocationRegistration {
  sessionId: string;
  toolUseId: string;
  direction: WorktreeTransitionDirection;
  observedAt: number;
  claimedGeneration: number | null;
}

function eventPayload(event: AgentEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === 'object'
    ? (event.payload as Record<string, unknown>)
    : {};
}

export function directionForWorktreeToolName(
  toolName: unknown,
): WorktreeTransitionDirection | null {
  if (toolName === `${TOOL_PREFIX}enter_worktree`) return 'enter';
  if (toolName === `${TOOL_PREFIX}exit_worktree`) return 'exit';
  return null;
}

/**
 * Provider observations are the authority for MCP tool identity. Handlers claim one unambiguous
 * live registration; they never guess from a tool name or HTTP request ordering.
 */
export class WorktreeToolInvocationRegistry {
  private readonly registrations = new Map<string, ToolInvocationRegistration>();

  observe(event: AgentEvent): void {
    if (event.source !== 'sdk' || event.kind !== 'tool-use-start') return;
    const payload = eventPayload(event);
    const direction = directionForWorktreeToolName(payload.toolName);
    const toolUseId =
      typeof payload.toolUseId === 'string' ? payload.toolUseId : null;
    if (!direction || !toolUseId) return;
    this.prune(event.ts);
    const key = this.key(event.sessionId, toolUseId);
    const existing = this.registrations.get(key);
    if (existing) return;
    this.registrations.set(key, {
      sessionId: event.sessionId,
      toolUseId,
      direction,
      observedAt: event.ts,
      claimedGeneration: null,
    });
  }

  reserve(
    sessionId: string,
    direction: WorktreeTransitionDirection,
    now = Date.now(),
  ): string {
    this.prune(now);
    const candidates = [...this.registrations.values()].filter(
      (entry) =>
        entry.sessionId === sessionId &&
        entry.direction === direction &&
        entry.claimedGeneration === null,
    );
    if (candidates.length !== 1) {
      const reason =
        candidates.length === 0
          ? 'no provider-observed tool invocation is available'
          : `${candidates.length} provider-observed invocations are ambiguous`;
      throw new Error(
        `Cannot arm ${direction}_worktree for session ${sessionId}: ${reason}. Retry the MCP call from the active turn.`,
      );
    }
    candidates[0]!.claimedGeneration = 0;
    return candidates[0]!.toolUseId;
  }

  bindGeneration(
    sessionId: string,
    toolUseId: string,
    generation: number,
  ): void {
    const current = this.registrations.get(this.key(sessionId, toolUseId));
    if (!current || current.claimedGeneration !== 0) {
      throw new Error(
        `Provider tool invocation ${sessionId}:${toolUseId} is not reserved.`,
      );
    }
    current.claimedGeneration = generation;
  }

  release(
    sessionId: string,
    toolUseId: string,
    generation?: number,
  ): void {
    const key = this.key(sessionId, toolUseId);
    const current = this.registrations.get(key);
    if (!current) return;
    if (
      generation !== undefined &&
      current.claimedGeneration !== generation
    ) {
      return;
    }
    this.registrations.delete(key);
  }

  renameSession(fromSessionId: string, toSessionId: string): void {
    if (fromSessionId === toSessionId) return;
    for (const entry of [...this.registrations.values()]) {
      if (entry.sessionId !== fromSessionId) continue;
      this.registrations.delete(this.key(fromSessionId, entry.toolUseId));
      entry.sessionId = toSessionId;
      this.registrations.set(this.key(toSessionId, entry.toolUseId), entry);
    }
  }

  private prune(now: number): void {
    for (const [key, entry] of this.registrations) {
      if (now - entry.observedAt > REGISTRATION_TTL_MS) {
        this.registrations.delete(key);
      }
    }
  }

  private key(sessionId: string, toolUseId: string): string {
    return `${sessionId}\u0000${toolUseId}`;
  }
}

export const worktreeToolInvocationRegistry =
  new WorktreeToolInvocationRegistry();
