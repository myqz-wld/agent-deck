import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import type { CodexLiveRateHost } from './live-token-rate-core';

export const desktopCodexLiveRateHost: CodexLiveRateHost = {
  resolveModel: (applicationSid, sessionId) =>
    sessionRepo.get(applicationSid)?.model ?? sessionRepo.get(sessionId)?.model ?? null,
  emitTokenRateTick: (event) => eventBus.emit('token-rate-tick', event),
};
