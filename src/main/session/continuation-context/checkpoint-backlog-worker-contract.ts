import type { CheckpointBacklogEstimate } from './checkpoint-backlog-estimator';

export const CHECKPOINT_BACKLOG_WORKER_KIND = 'agent-deck-checkpoint-backlog-v1';

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
