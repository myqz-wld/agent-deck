import {
  REMOTE_HOST_RESOURCE_KINDS,
  type RemoteHostResourceKind,
} from '@shared/remote-host';

const SESSION_LIFECYCLE_RESOURCES = [
  'session-list',
  'session-detail',
  'pending',
  'teams',
] as const satisfies readonly RemoteHostResourceKind[];
const SESSION_EVENT_RESOURCES = [
  'session-list',
  'session-detail',
  'teams',
] as const satisfies readonly RemoteHostResourceKind[];
const DETAIL_AND_TEAMS = [
  'session-detail',
  'teams',
] as const satisfies readonly RemoteHostResourceKind[];
const PENDING_RESOURCES = [
  'pending',
  'session-detail',
  'teams',
] as const satisfies readonly RemoteHostResourceKind[];

/** Maps the open-ended Core event namespace into a bounded desktop refresh allowlist. */
export function remoteHostResourcesForCoreEvent(
  eventKind: string,
): readonly RemoteHostResourceKind[] {
  if (eventKind.startsWith('usage.')) return ['usage'];
  if (eventKind.startsWith('issue.')) return ['issues'];
  if (eventKind.startsWith('node.hook.')) return ['node-configuration'];
  if (eventKind.startsWith('node.asset.')) return ['node-assets'];
  if (eventKind.startsWith('team.')) return SESSION_EVENT_RESOURCES;
  if (eventKind.startsWith('pending.') || eventKind.startsWith('plan.review.')) {
    return PENDING_RESOURCES;
  }
  if (eventKind.startsWith('task.') || eventKind.startsWith('message.')) {
    return DETAIL_AND_TEAMS;
  }
  if (
    eventKind.startsWith('session.')
  ) return SESSION_LIFECYCLE_RESOURCES;
  if (
    eventKind.startsWith('event.') ||
    eventKind.startsWith('subscription.') ||
    eventKind.startsWith('worktree.')
  ) {
    return SESSION_EVENT_RESOURCES;
  }
  // A future Core event must not leave any already-rendered Remote projection stale.
  return REMOTE_HOST_RESOURCE_KINDS;
}
