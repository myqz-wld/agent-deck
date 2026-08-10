import type { RemoteHostSessionSummaryDto } from '@shared/remote-host';
import type { ActivityState, LifecycleState } from '@shared/types';

const LIFECYCLES: readonly LifecycleState[] = ['active', 'dormant', 'closed'];
const ACTIVITIES: readonly ActivityState[] = ['idle', 'working', 'waiting', 'finished'];

export interface RemoteSessionStatusPresentation {
  activity: ActivityState;
  lifecycle: LifecycleState;
}

/**
 * Current Core summaries encode `${lifecycle}-${activity}` in the bounded status token. Older
 * fixtures and compatible hosts may expose one half only, so presentation stays fail-closed and
 * deterministic without widening the wire contract.
 */
export function remoteSessionStatus(status: string): RemoteSessionStatusPresentation {
  const separator = status.indexOf('-');
  const lifecycleToken = separator < 0 ? status : status.slice(0, separator);
  const activityToken = separator < 0 ? status : status.slice(separator + 1);
  const lifecycle = LIFECYCLES.includes(lifecycleToken as LifecycleState)
    ? lifecycleToken as LifecycleState
    : 'active';
  const activity = ACTIVITIES.includes(activityToken as ActivityState)
    ? activityToken as ActivityState
    : ACTIVITIES.includes(status as ActivityState)
      ? status as ActivityState
      : lifecycle === 'closed'
        ? 'finished'
        : 'idle';
  return { activity, lifecycle };
}

export function groupRemoteSessionSummaries(
  sessions: readonly RemoteHostSessionSummaryDto[],
): {
  active: RemoteHostSessionSummaryDto[];
  dormant: RemoteHostSessionSummaryDto[];
  closed: RemoteHostSessionSummaryDto[];
} {
  const grouped = {
    active: [] as RemoteHostSessionSummaryDto[],
    dormant: [] as RemoteHostSessionSummaryDto[],
    closed: [] as RemoteHostSessionSummaryDto[],
  };
  for (const session of sessions) {
    grouped[remoteSessionStatus(session.status).lifecycle].push(session);
  }
  return grouped;
}

export function remoteSessionActivityCounts(
  sessions: readonly RemoteHostSessionSummaryDto[],
): { waiting: number; working: number } {
  let waiting = 0;
  let working = 0;
  for (const session of sessions) {
    const { activity } = remoteSessionStatus(session.status);
    if (activity === 'waiting') waiting += 1;
    if (activity === 'working') working += 1;
  }
  return { waiting, working };
}
