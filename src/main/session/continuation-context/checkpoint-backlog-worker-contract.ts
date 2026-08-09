export const CHECKPOINT_BACKLOG_WORKER_KIND = 'agent-deck-checkpoint-backlog-v1';
export const DEFAULT_CHECKPOINT_BACKLOG_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_CHECKPOINT_BACKLOG_MAX_ROWS = 10_000;

export interface CheckpointBacklogEstimate {
  sessionId: string;
  /** Eligibility observation only; background capture may advance beyond this revision. */
  captureRevision: number;
  rebuildAfterRevision: number;
  checkpointThroughRevision: number;
  checkpointCreatedAt: number | null;
  estimatedTokens: number;
  sourceRows: number;
  /** True means a resource guard proved the safety threshold should fire, not an exact estimate. */
  saturated: boolean;
}

export interface CheckpointBacklogWorkerData {
  kind: typeof CHECKPOINT_BACKLOG_WORKER_KIND;
  dbPath: string;
}

export type CheckpointBacklogWorkerCommand =
  | {
      type: 'estimate';
      requestId: number;
      sessionId: string;
      saturationTokens: number;
      maxSourceBytes: number;
      maxRows: number;
    }
  | { type: 'close'; requestId: number };

export type CheckpointBacklogWorkerMessage =
  | { type: 'ready' }
  | {
      type: 'estimate-result';
      requestId: number;
      result: CheckpointBacklogEstimate | null;
    }
  | { type: 'estimate-error'; requestId: number; error: string }
  | { type: 'closed'; requestId: number }
  | { type: 'fatal'; error: string };
