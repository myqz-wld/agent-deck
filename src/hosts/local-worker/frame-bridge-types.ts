import type { RelayResetCode } from '@protocol/relay';
import type { RemoteOwnerGrantClaim } from '@contracts/index';

export interface CoreFrameOutput {
  readonly maxChunkBytes: number;
  /** Await admission before sending another chunk; false means this stream was terminated. */
  data(payload: Uint8Array): Promise<boolean>;
  close(): void;
  reset(code?: RelayResetCode): void;
}

export interface CoreFrameChannel {
  write(payload: Uint8Array): boolean;
  closeInput(): void;
  reset(code: RelayResetCode): void;
}

export interface CoreFrameChannelFactory {
  open(
    streamId: string,
    output: CoreFrameOutput,
    access: CoreFrameAccessContext,
  ): CoreFrameChannel;
}

export interface CoreFrameAccessContext {
  readonly connectionScope: string;
  readonly surface: 'desktop' | 'feishu';
  readonly grant: RemoteOwnerGrantClaim;
}

export interface LocalWorkerFrameBridgeLimits {
  initialCreditBytes: number;
  maxCreditBytes: number;
  maxOutputQueueBytesPerStream: number;
  maxOutputQueueBytesTotal: number;
  maxOutputQueueFramesPerStream: number;
  maxOutputQueueFramesTotal: number;
  maxFrameBytes: number;
}

export const DEFAULT_LOCAL_WORKER_BRIDGE_LIMITS: LocalWorkerFrameBridgeLimits = {
  initialCreditBytes: 256 * 1024,
  maxCreditBytes: 1024 * 1024,
  maxOutputQueueBytesPerStream: 512 * 1024,
  maxOutputQueueBytesTotal: 4 * 1024 * 1024,
  maxOutputQueueFramesPerStream: 1024,
  maxOutputQueueFramesTotal: 8192,
  maxFrameBytes: 4 * 1024 * 1024,
};

export interface BridgeStream {
  streamId: string;
  nextInboundSequence: number;
  nextOutboundSequence: number;
  inputCredit: number;
  inputClosed: boolean;
  outputCredit: number;
  outputChunkBytes: number;
  outputQueue: Uint8Array[];
  outputQueueBytes: number;
  closePending: boolean;
  outputWaiter: (() => void) | null;
  channel: CoreFrameChannel | null;
}

export function assertLimits(limits: LocalWorkerFrameBridgeLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  if (limits.initialCreditBytes > limits.maxCreditBytes) {
    throw new RangeError('initialCreditBytes cannot exceed maxCreditBytes');
  }
  if (limits.maxOutputQueueBytesPerStream > limits.maxOutputQueueBytesTotal) {
    throw new RangeError('Per-stream output queue cannot exceed total output queue');
  }
  if (limits.maxOutputQueueFramesPerStream > limits.maxOutputQueueFramesTotal) {
    throw new RangeError('Per-stream output frames cannot exceed total output frames');
  }
}
