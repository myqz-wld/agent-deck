import type { Database } from 'better-sqlite3';
import { estimateCheckpointBacklog } from '@main/session/continuation-context/checkpoint-backlog-estimator';
import {
  createWorkerOwnedBackgroundFoldSource,
  materializeBackgroundCheckpointSource,
} from '@main/session/continuation-context/checkpoint-background-materializer';
import {
  BACKGROUND_MATERIALIZE_MAX_WIRE_BYTES,
} from '@main/session/continuation-context/checkpoint-background-worker-contract';
import type { CheckpointBackgroundChunkSource } from '@main/session/continuation-context/checkpoint-background-worker-client';

/** File-worker equivalent for the already isolated headless process. */
export function createServerCoreCheckpointSource(
  db: Database,
  sessionId: string,
): CheckpointBackgroundChunkSource {
  const materialized = materializeBackgroundCheckpointSource(db, { sessionId });
  const source = createWorkerOwnedBackgroundFoldSource(
    materialized,
    BACKGROUND_MATERIALIZE_MAX_WIRE_BYTES,
  );
  return {
    metadata: source.metadata,
    buildNextChunk: (input) => source.buildNextChunk(input),
    close: async () => undefined,
  };
}

export function estimateServerCoreCheckpointBacklog(
  db: Database,
  sessionId: string,
) {
  return estimateCheckpointBacklog({
    db,
    sessionId,
    saturationTokens: 48_000,
  });
}
