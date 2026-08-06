import { eventBus } from '@main/event-bus';
import { guardHandOffSourceIngress } from '@main/session/hand-off/ingress-guard';
import { worktreeToolInvocationRegistry } from '@main/session/worktree-transition/tool-invocation-registry';
import { getDb } from '@main/store/db';
import { sessionRepo } from '@main/store/session-repo';

import { desktopGrokBridgeDiagnostics } from './bridge-diagnostics-host';
import type { GrokBridgeRuntimeHost } from './bridge-runtime-core';
import { desktopGrokLiveRateObserver } from './live-token-rate-host';

export const desktopGrokBridgeRuntimeHost: GrokBridgeRuntimeHost = {
  diagnostics: desktopGrokBridgeDiagnostics,
  liveRate: desktopGrokLiveRateObserver,
  records: {
    get: (sessionId) => sessionRepo.get(sessionId),
    setAgentRuntimeProfile: (sessionId, profile) =>
      sessionRepo.setAgentRuntimeProfile(sessionId, profile),
    setRuntimeProvider: (sessionId, provider) =>
      sessionRepo.setRuntimeProvider(sessionId, provider),
    setModel: (sessionId, model) => sessionRepo.setModel(sessionId, model),
    setThinking: (sessionId, thinking) =>
      sessionRepo.setThinking(sessionId, thinking),
    setSessionMode: (sessionId, mode) =>
      sessionRepo.setSessionMode(sessionId, mode),
    setGrokSandbox: (sessionId, sandbox) =>
      sessionRepo.setGrokSandbox(sessionId, sandbox),
    setGrokUsageWatermark: (sessionId, watermark) =>
      sessionRepo.setGrokUsageWatermark(sessionId, watermark),
  },
  transaction: (operation) => getDb().transaction(operation)(),
  publishSessionUpdated: (sessionId) => {
    const record = sessionRepo.get(sessionId);
    if (record) eventBus.emit('session-upserted', record);
  },
  guardHandOffSourceIngress: (args) =>
    guardHandOffSourceIngress({ ...args, agentId: 'grok-build' }),
  hasPendingWorktreeTransition: (sessionId) =>
    worktreeToolInvocationRegistry.hasPendingTransition(sessionId),
};
