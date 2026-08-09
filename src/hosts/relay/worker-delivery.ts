import { workerWireMessageBytes } from '@protocol/relay';
import { BoundedRelayFrameQueue } from './bounded-queue';
import type { RelayRouteFrame } from '@protocol/relay';
import type { RelayRouterLimits } from './router-types';

export function drainWorkerFrames(
  queue: BoundedRelayFrameQueue,
  limits: RelayRouterLimits,
  maxBytes: number,
): RelayRouteFrame[] {
  return queue.drainByCost(maxBytes, (frame) =>
    workerWireMessageBytes(
      { type: 'route', frame },
      {
        maxFrameBytes: limits.maxFrameBytes,
        maxCreditBytes: limits.maxCreditBytes,
      },
    ),
  );
}
