export type StableSnapshotResult = 'applied' | 'cancelled' | 'unstable';

interface LoadStableSnapshotOptions<T, Version> {
  readVersion: () => Version;
  load: () => Promise<T>;
  apply: (snapshot: T) => void;
  isCancelled?: () => boolean;
  maxAttempts?: number;
}

/**
 * Load an IPC snapshot without letting a late response overwrite newer push events.
 *
 * Callers expose a version that changes only for live mutations in the same domain.
 * A changed version invalidates the response and triggers a fresh read. `apply` is
 * synchronous, so no renderer event can interleave between the final version check
 * and the state replacement.
 */
export async function loadStableSnapshot<T, Version>({
  readVersion,
  load,
  apply,
  isCancelled = () => false,
  maxAttempts = 4,
}: LoadStableSnapshotOptions<T, Version>): Promise<StableSnapshotResult> {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive safe integer');
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (isCancelled()) return 'cancelled';
    const version = readVersion();
    const snapshot = await load();
    if (isCancelled()) return 'cancelled';
    if (!Object.is(version, readVersion())) continue;
    apply(snapshot);
    return 'applied';
  }

  return 'unstable';
}
