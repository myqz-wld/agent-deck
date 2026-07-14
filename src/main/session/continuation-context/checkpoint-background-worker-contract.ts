import type { BackgroundMaterializedMetadata } from './checkpoint-background-materializer';
import type { FoldChunkView } from './checkpoint-fold-chunk';
import type { ContinuationCheckpoint } from './checkpoint-schema';

export const CHECKPOINT_BACKGROUND_WORKER_KIND = 'agent-deck-checkpoint-background-v1';

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
