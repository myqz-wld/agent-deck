import type {
  WorkerAttachRejected,
  WorkerAttachRequest,
  WorkerAttached,
} from '@protocol/relay';
import type { RelayRouteFrame } from '@protocol/relay';
import type { LocalWorkerSshConfig } from './config';
import type { CoreFrameChannelFactory, LocalWorkerFrameBridgeLimits } from './frame-bridge';

export type WorkerAttachmentState =
  | 'stopped'
  | 'connecting'
  | 'online'
  | 'backoff'
  | 'fenced';

export interface WorkerAttachmentStatus {
  state: WorkerAttachmentState;
  generation: number | null;
  attempt: number;
  nextRetryAt: number | null;
  lastHeartbeatAckAt: number | null;
  lastErrorCode: string | null;
}

export interface WorkerAttachmentSessionHandlers {
  onFrame(frame: RelayRouteFrame): void;
  onClose(error?: Error): void;
}

export interface WorkerAttachmentSession {
  attached: WorkerAttached;
  setHandlers(handlers: WorkerAttachmentSessionHandlers): void;
  send(frame: RelayRouteFrame): void;
  close(): Promise<void>;
}

export interface WorkerAttachmentConnector {
  connect(
    config: LocalWorkerSshConfig,
    request: WorkerAttachRequest,
  ): Promise<WorkerAttachmentSession>;
}

export class WorkerAttachmentConnectError extends Error {
  constructor(readonly rejection: WorkerAttachRejected) {
    super(rejection.message);
    this.name = 'WorkerAttachmentConnectError';
  }
}

export class WorkerAttachmentRetirementError extends Error {
  readonly errors: readonly Error[];

  constructor(reason: Error, cleanup: unknown) {
    const cleanupError = cleanup instanceof Error ? cleanup : new Error('Unknown cleanup error');
    super(`${reason.message}; Worker attachment retirement failed`);
    this.name = 'WorkerAttachmentRetirementError';
    this.errors = [reason, cleanupError];
  }
}

export interface AttachmentScheduler {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

export const DEFAULT_ATTACHMENT_SCHEDULER: AttachmentScheduler = {
  set: (delayMs, callback) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface WorkerAttachmentOptions {
  initialGeneration?: number | null;
  heartbeatIntervalMs?: number;
  backoffInitialMs?: number;
  backoffMaximumMs?: number;
  backoffJitterRatio?: number;
  scheduler?: AttachmentScheduler;
  now?: () => number;
  random?: () => number;
  bridgeLimits?: LocalWorkerFrameBridgeLimits;
  onStatus?: (status: WorkerAttachmentStatus) => void;
  onGeneration?: (generation: number) => void;
}

export type { CoreFrameChannelFactory };
