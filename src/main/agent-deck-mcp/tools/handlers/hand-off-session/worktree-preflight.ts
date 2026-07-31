import { resolve } from 'node:path';
import { isAgentId } from '@main/adapters/options-builder';
import { adapterRegistry } from '@main/adapters/registry';
import { isDbInitialized } from '@main/store/db';
import { worktreeTransitionRepo } from '@main/store/worktree-transition-repo';
import type { SessionRecord } from '@shared/types';
import type { HandOffSessionHandlerDeps } from './_deps';
import type { HandOffResourceTransferResult } from './resource-transfer-coordinator';

interface HandOffWorktreeError {
  error: string;
  hint: string;
}

export function resourceTransferFailed(
  result: HandOffResourceTransferResult,
): boolean {
  return (
    result.tasks.status === 'failed' ||
    result.teams.status === 'failed' ||
    result.worktreeLease.status === 'failed'
  );
}

export function validateWorktreeHandOffPreflight(input: {
  source: SessionRecord;
  finalCwd: string;
  deps?: HandOffSessionHandlerDeps;
}): HandOffWorktreeError | null {
  const { source, finalCwd, deps } = input;
  const transition = (
    deps?.worktreeTransition ??
    ((sessionId: string) =>
      isDbInitialized() ? worktreeTransitionRepo.get(sessionId) : null)
  )(source.id);
  if (
    transition &&
    transition.phase !== 'active' &&
    transition.phase !== 'cleared'
  ) {
    return {
      error:
        `worktree cwd transition is still pending: ` +
        `${source.id}:${transition.generation}:${transition.phase}`,
      hint:
        'Wait for the automatic working-directory transition to settle, then retry ' +
        'hand_off_session. No successor was created and no resources moved.',
    };
  }
  if (transition?.phase !== 'active') return null;

  const runtimeCwd = (
    deps?.sourceRuntimeCwd ??
    ((sessionId: string) =>
      isAgentId(source.agentId)
        ? adapterRegistry.get(source.agentId)?.getRuntimeCwd?.(sessionId) ??
          null
        : null)
  )(source.id);
  if (
    resolve(source.cwd) === resolve(transition.worktreePath) &&
    resolve(finalCwd) === resolve(transition.worktreePath) &&
    (runtimeCwd === null ||
      resolve(runtimeCwd) === resolve(transition.worktreePath))
  ) {
    return null;
  }
  return {
    error: `active worktree lease cwd mismatch for ${source.id}`,
    hint:
      'The persisted source cwd, requested successor cwd, and any live source runtime must all ' +
      `match ${transition.worktreePath}. Do not override cwd while transferring an active ` +
      'worktree lease.',
  };
}
