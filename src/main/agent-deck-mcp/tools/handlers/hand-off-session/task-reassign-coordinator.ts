import { taskRepo } from '@main/store/task-repo';
import type { HandOffSessionHandlerDeps } from './_deps';
import type { Phase15Detail } from './team-adopt-coordinator';

export type TaskReassignmentCompatResult =
  | { status: 'ok'; count: number }
  | { status: 'failed'; error: string; count: 0 }
  | { status: 'skipped'; reason: 'spawn-no-sid'; count: 0 };

export function runTaskReassignment(
  _args: unknown,
  callerSessionId: string,
  newSpawnedSid: string | null,
  _phase15Detail: Phase15Detail,
  handlerDeps: HandOffSessionHandlerDeps | undefined,
): TaskReassignmentCompatResult {
  if (!newSpawnedSid) return { status: 'skipped', reason: 'spawn-no-sid', count: 0 };
  try {
    const reassign = handlerDeps?.reassignTaskOwner ?? taskRepo.reassignOwner;
    const count = reassign(callerSessionId, newSpawnedSid, { policy: 'preserve-team' });
    return { status: 'ok', count };
  } catch (e) {
    return {
      status: 'failed',
      count: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
