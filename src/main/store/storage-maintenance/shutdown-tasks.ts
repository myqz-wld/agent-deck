import type { Database } from 'better-sqlite3';
import {
  retireLegacyEventSearchIndexOnShutdown,
  type LegacyEventSearchRetirementResult,
} from './event-search';
import {
  prepareSnapshotGcIndexesOnShutdown,
  type SnapshotIndexPreparationResult,
} from './file-snapshots';
import { boundedMaintenanceError, readMaintenanceState } from './state';

export type StorageShutdownTaskOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; error: string };

export interface StorageShutdownTaskResults {
  snapshotIndexes: StorageShutdownTaskOutcome<SnapshotIndexPreparationResult>;
  eventSearchRetirement: StorageShutdownTaskOutcome<LegacyEventSearchRetirementResult>;
}

interface ShutdownTaskDependencies {
  prepareSnapshotIndexes: typeof prepareSnapshotGcIndexesOnShutdown;
  retireEventSearch: typeof retireLegacyEventSearchIndexOnShutdown;
}

const DEFAULT_DEPENDENCIES: ShutdownTaskDependencies = {
  prepareSnapshotIndexes: prepareSnapshotGcIndexesOnShutdown,
  retireEventSearch: retireLegacyEventSearchIndexOnShutdown,
};

/** Cheap main-connection gate so ordinary shutdowns do not spawn an unnecessary worker. */
export function hasPendingStorageShutdownTasks(db: Database): boolean {
  return (
    readMaintenanceState(db, 'file-snapshot-blobs-v1')?.phase === 'indexes-on-shutdown' ||
    readMaintenanceState(db, 'event-search-v1')?.phase === 'retire-on-shutdown'
  );
}

/**
 * Runs both independent, retryable shutdown transactions. One failure must not prevent the other
 * task from making progress; each helper advances its own durable phase only inside its transaction.
 */
export function runStorageShutdownTasks(
  db: Database,
  dependencies: ShutdownTaskDependencies = DEFAULT_DEPENDENCIES,
): StorageShutdownTaskResults {
  return {
    snapshotIndexes: attempt(() => dependencies.prepareSnapshotIndexes(db)),
    eventSearchRetirement: attempt(() => dependencies.retireEventSearch(db)),
  };
}

function attempt<T>(task: () => T): StorageShutdownTaskOutcome<T> {
  try {
    return { ok: true, result: task() };
  } catch (error) {
    return { ok: false, error: boundedMaintenanceError(error) };
  }
}
