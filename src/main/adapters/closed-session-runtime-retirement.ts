import type { AgentAdapter } from './types';

/**
 * Re-run provider retirement for a durably closed session without rewriting its
 * lifecycle history. Worktree cleanup may proceed only after the adapter stops
 * reporting a runtime cwd for that session.
 */
export async function retireClosedSessionRuntime(
  adapter: AgentAdapter | undefined,
  sessionId: string,
): Promise<void> {
  if (!adapter) return;
  await adapter.closeSession?.(sessionId);
  if ((adapter.getRuntimeCwd?.(sessionId) ?? null) !== null) {
    throw new Error(
      `adapter ${adapter.id} 未能释放已关闭 session ${sessionId} 的 runtime cwd`,
    );
  }
}
