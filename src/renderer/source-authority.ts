import type { RemoteHostSnapshotDto } from '@shared/remote-host';

export type AppSourceAuthority = 'unknown' | 'local' | 'remote';

export function appSourceAuthority(
  snapshot: RemoteHostSnapshotDto | null,
): AppSourceAuthority {
  return snapshot?.sourceMode ?? 'unknown';
}
