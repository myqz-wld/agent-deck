import {
  captureRecoveryContinuation,
  cleanupRecoveryContinuation,
  prepareRecoveryContinuation,
} from './recovery';
import type { RecoveryContinuationHost } from './recovery-types';

export const desktopRecoveryContinuationHost: RecoveryContinuationHost = {
  captureContinuation: (input) => captureRecoveryContinuation(input),
  prepareContinuation: (input) => prepareRecoveryContinuation(input),
  cleanupContinuation: (capture) => cleanupRecoveryContinuation(capture),
};
