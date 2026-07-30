import type {
  WorktreeTransitionDirection,
  WorktreeTransitionPhase,
} from './types';

const NEXT_PHASES: Readonly<
  Record<WorktreeTransitionPhase, ReadonlySet<WorktreeTransitionPhase>>
> = {
  creating: new Set(['enter_waiting_tool_result', 'cleared']),
  enter_waiting_tool_result: new Set([
    'interrupting_enter_turn',
    'cleared',
  ]),
  interrupting_enter_turn: new Set([
    'switching_to_worktree',
    'cleared',
  ]),
  switching_to_worktree: new Set([
    'active',
    'enter_waiting_tool_result',
    'cleared',
  ]),
  active: new Set(['exit_preflight', 'cleared']),
  exit_preflight: new Set(['exit_waiting_tool_result', 'active']),
  exit_waiting_tool_result: new Set([
    'interrupting_exit_turn',
    'active',
  ]),
  interrupting_exit_turn: new Set([
    'restoring_original_cwd',
    'active',
  ]),
  restoring_original_cwd: new Set(['cleanup_pending', 'active']),
  cleanup_pending: new Set(['cleared']),
  cleared: new Set(['creating']),
};

const ENTER_PHASES = new Set<WorktreeTransitionPhase>([
  'creating',
  'enter_waiting_tool_result',
  'interrupting_enter_turn',
  'switching_to_worktree',
]);

const EXIT_PHASES = new Set<WorktreeTransitionPhase>([
  'exit_preflight',
  'exit_waiting_tool_result',
  'interrupting_exit_turn',
  'restoring_original_cwd',
  'cleanup_pending',
]);

export function assertWorktreeTransitionStep(
  from: WorktreeTransitionPhase,
  to: WorktreeTransitionPhase,
): void {
  if (NEXT_PHASES[from].has(to)) return;
  throw new Error(`Illegal worktree cwd transition phase: ${from} -> ${to}`);
}

export function assertDirectionMatchesPhase(
  direction: WorktreeTransitionDirection,
  phase: WorktreeTransitionPhase,
): void {
  if (phase === 'active' || phase === 'cleared') return;
  if (direction === 'enter' && ENTER_PHASES.has(phase)) return;
  if (direction === 'exit' && EXIT_PHASES.has(phase)) return;
  throw new Error(
    `Worktree cwd transition direction ${direction} is incompatible with phase ${phase}`,
  );
}

export function isSettledWorktreeTransition(
  phase: WorktreeTransitionPhase,
): boolean {
  return phase === 'active' || phase === 'cleared';
}

export function isPendingWorktreeTransition(
  phase: WorktreeTransitionPhase,
): boolean {
  return !isSettledWorktreeTransition(phase);
}
