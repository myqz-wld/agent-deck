import type { ContinuationCheckpointRecord } from '@main/store/continuation-checkpoint-read';
import type { FoldChunkView } from './checkpoint-fold-chunk';
import type { ContinuationCheckpoint } from './checkpoint-schema';

export const CHECKPOINT_BACKGROUND_WORKER_KIND = 'agent-deck-checkpoint-background-v1';
export const BACKGROUND_MATERIALIZE_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const BACKGROUND_MATERIALIZE_MAX_ROWS = 10_000;
export const BACKGROUND_MATERIALIZE_MAX_WIRE_BYTES = 1024 * 1024;

export interface BackgroundMaterializedMetadata {
  sessionId: string;
  captureRevision: number;
  rebuildAfterRevision: number;
  maxEventId: number | null;
  runtimeFingerprint: string;
  checkpoint: ContinuationCheckpointRecord | null;
  checkpointThroughRevision: number;
  materializedThroughRevision: number;
  sourceRows: number;
  sourceBytes: number;
  groupCount: number;
  normalizedEventCount: number;
  truncatedBy: 'none' | 'rows' | 'source-bytes';
}

export interface CheckpointBackgroundWorkerData {
  kind: typeof CHECKPOINT_BACKGROUND_WORKER_KIND;
  dbPath: string;
  sessionId: string;
  maxSourceBytes: number;
  maxRows: number;
  maxWireBytes: number;
}

export type CheckpointBackgroundWorkerCommand =
  | {
      type: 'build-next-chunk';
      requestId: number;
      cursor: number;
      coveredThroughRevision: number;
      previous: ContinuationCheckpoint | null;
      budget: number;
    }
  | { type: 'close'; requestId: number };

export interface CheckpointBackgroundReadyPayload {
  metadata: BackgroundMaterializedMetadata;
}

export interface CheckpointBackgroundChunkPayload {
  chunk: FoldChunkView | null;
}

export type CheckpointBackgroundWorkerMessage =
  | { type: 'ready'; payloadJson: string }
  | { type: 'chunk-result'; requestId: number; payloadJson: string }
  | { type: 'chunk-error'; requestId: number; error: string }
  | { type: 'closed'; requestId: number }
  | { type: 'fatal'; error: string };
