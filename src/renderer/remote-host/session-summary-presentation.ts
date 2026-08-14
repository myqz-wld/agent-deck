import type { RemoteHostSessionPresentationDto } from '@shared/remote-host';

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
