import type {
  RemoteHostSessionPresentationDto,
  RemoteHostSessionSummaryDto,
} from '@shared/remote-host';
import type { ActivityState, LifecycleState } from '@shared/types';

const LIFECYCLES: readonly LifecycleState[] = ['active', 'dormant', 'closed'];
const ACTIVITIES: readonly ActivityState[] = ['idle', 'working', 'waiting', 'finished'];

export interface RemoteSessionStatusPresentation {
  activity: ActivityState;
  lifecycle: LifecycleState;
}

/**
 * Legacy Core summaries encode `${lifecycle}-${activity}`. Unknown values are incompatible; they
 * must never be silently presented as an Active session.
 */
export function remoteSessionStatus(status: string): RemoteSessionStatusPresentation {
  const separator = status.indexOf('-');
  const lifecycleToken = separator < 0 ? status : status.slice(0, separator);
  const activityToken = separator < 0 ? status : status.slice(separator + 1);
  if (!LIFECYCLES.includes(lifecycleToken as LifecycleState) ||
      !ACTIVITIES.includes(activityToken as ActivityState)) {
    throw new Error('远端返回了无法识别的会话状态。');
  }
  const lifecycle = lifecycleToken as LifecycleState;
  const activity = activityToken as ActivityState;
  return { activity, lifecycle };
}

export function legacyRemoteSessionPresentation(
  session: RemoteHostSessionSummaryDto,
): RemoteHostSessionPresentationDto {
  const status = remoteSessionStatus(session.status);
  return {
    id: session.id,
    adapterId: session.adapterId,
    title: session.title ?? '未命名会话',
    source: 'sdk',
    lifecycle: status.lifecycle,
    activity: status.activity,
    archived: status.lifecycle === 'closed',
    pinned: false,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    endedAt: null,
    model: null,
    thinking: null,
    runtimeProvider: null,
    context: null,
    spawnedBy: null,
    spawnDepth: 0,
    teams: [],
    summary: null,
    workspaceLabel: null,
    contextOnly: false,
  };
}

export function groupRemoteSessionSummaries(
  sessions: readonly RemoteHostSessionPresentationDto[],
): {
  active: RemoteHostSessionPresentationDto[];
  dormant: RemoteHostSessionPresentationDto[];
  closed: RemoteHostSessionPresentationDto[];
} {
  const grouped = {
    active: [] as RemoteHostSessionPresentationDto[],
    dormant: [] as RemoteHostSessionPresentationDto[],
    closed: [] as RemoteHostSessionPresentationDto[],
  };
  for (const session of sessions) {
    grouped[session.lifecycle].push(session);
  }
  return grouped;
}

export function remoteSessionActivityCounts(
  sessions: readonly RemoteHostSessionPresentationDto[],
): { waiting: number; working: number } {
  let waiting = 0;
  let working = 0;
  for (const session of sessions) {
    const { activity, lifecycle } = session;
    if (lifecycle === 'closed') continue;
    if (activity === 'waiting') waiting += 1;
    if (activity === 'working') working += 1;
  }
  return { waiting, working };
}
