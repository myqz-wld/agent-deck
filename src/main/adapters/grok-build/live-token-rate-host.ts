import { eventBus } from '@main/event-bus';
import type { GrokLiveRateObserver } from './live-token-rate-core';

export const desktopGrokLiveRateObserver: GrokLiveRateObserver = {
  emitTokenRateTick: (event) => eventBus.emit('token-rate-tick', event),
};
