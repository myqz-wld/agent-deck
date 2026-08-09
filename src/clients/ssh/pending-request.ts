import type { JsonValue } from '@contracts/index';
import type { ProtocolRequestMessage } from '@protocol/messages';

import { scheduleLongTimeout, type LongTimer } from './timers';
import type { SshRequestOptions } from './types';

export interface PendingRequest {
  message: ProtocolRequestMessage;
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timer: LongTimer | null;
  removeAbortListener: (() => void) | null;
}

export function createPendingRequest(message: ProtocolRequestMessage): {
  pending: PendingRequest;
  promise: Promise<JsonValue>;
} {
  let resolve!: (value: JsonValue) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<JsonValue>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return {
    promise,
    pending: { message, resolve, reject, timer: null, removeAbortListener: null },
  };
}

export function installPendingCancellation(
  pending: PendingRequest,
  options: SshRequestOptions | undefined,
  now: () => number,
  cancel: (reason: 'cancelled' | 'deadline') => void,
): void {
  if (pending.message.deadlineAt !== null) {
    pending.timer = scheduleLongTimeout(
      Math.max(0, pending.message.deadlineAt - now()),
      () => cancel('deadline'),
    );
  }
  if (options?.signal) {
    const abort = () => cancel('cancelled');
    options.signal.addEventListener('abort', abort, { once: true });
    pending.removeAbortListener = () => options.signal?.removeEventListener('abort', abort);
  }
}

export function cleanupPendingRequest(pending: PendingRequest): void {
  pending.timer?.cancel();
  pending.removeAbortListener?.();
}
