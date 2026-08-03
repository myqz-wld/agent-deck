export const WORKTREE_TRANSITION_PHASES = [
  'creating',
  'enter_waiting_tool_result',
  'interrupting_enter_turn',
  'switching_to_worktree',
  'active',
  'exit_preflight',
  'exit_waiting_tool_result',
  'interrupting_exit_turn',
  'restoring_original_cwd',
  'cleanup_pending',
  'cleared',
] as const;

export type WorktreeTransitionPhase =
  (typeof WORKTREE_TRANSITION_PHASES)[number];

export type WorktreeTransitionDirection = 'enter' | 'exit';

export interface WorktreeTransitionRecord {
  sessionId: string;
  generation: number;
  direction: WorktreeTransitionDirection;
  phase: WorktreeTransitionPhase;
  originalCwd: string;
  targetCwd: string;
  mainRepo: string;
  worktreePath: string;
  baseCommit: string;
  /** Exact provider invocation while transition ingress is open; null after the atomic drain seal. */
  toolUseId: string | null;
  continuationKey: string;
  continuationDelivered: boolean;
  discardChanges: boolean;
  requestedAt: number;
  updatedAt: number;
  lastError: string | null;
}

export interface NewWorktreeTransition {
  sessionId: string;
  originalCwd: string;
  targetCwd: string;
  mainRepo: string;
  worktreePath: string;
  baseCommit: string;
  toolUseId: string;
  continuationKey: string;
  requestedAt: number;
}

export interface WorktreeExitOptions {
  toolUseId: string;
  continuationKey: string;
  discardChanges: boolean;
  requestedAt: number;
}

export interface WorktreeTransitionQueuedInput {
  sessionId: string;
  generation: number;
  sequence: number;
  agentId: string;
  text: string;
  attachments: unknown[];
  createdAt: number;
  deliveredAt: number | null;
}

export function worktreeTransitionId(
  transition: Pick<WorktreeTransitionRecord, 'sessionId' | 'generation'>,
): string {
  return `${transition.sessionId}:${transition.generation}`;
}
