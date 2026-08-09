import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import log from '@main/utils/logger';
import type { ClaudeSessionFinalizeHost } from './session-finalize-core';
import type { ClaudeSessionManagerPort } from '../session-manager-core';

const logger = log.scope('claude-finalize');

export function createDesktopClaudeSessionFinalizeHost(
  sessionManager: Pick<ClaudeSessionManagerPort, 'updateCliSessionId'>,
): ClaudeSessionFinalizeHost {
  return {
    now: () => Date.now(),
    updateCliSessionId: (applicationSid, cliSessionId) => {
      sessionManager.updateCliSessionId(applicationSid, cliSessionId);
    },
    setSandbox: (applicationSid, mode) => {
      sessionRepo.setClaudeCodeSandbox(applicationSid, mode);
    },
    setRuntimeProvider: (applicationSid, runtimeProvider) => {
      sessionRepo.setRuntimeProvider(applicationSid, runtimeProvider);
    },
    setAgentRuntimeProfile: (applicationSid, profile) => {
      sessionRepo.setAgentRuntimeProfile(applicationSid, profile);
    },
    setModel: (applicationSid, model) => sessionRepo.setModel(applicationSid, model),
    setThinking: (applicationSid, effort) => sessionRepo.setThinking(applicationSid, effort),
    setExtraAllowWrite: (applicationSid, paths) => {
      sessionRepo.setExtraAllowWrite(applicationSid, paths);
    },
    publishPersistedSession: (applicationSid) => {
      const updated = sessionRepo.get(applicationSid);
      if (updated) eventBus.emit('session-upserted', updated);
    },
    warn: (message, error) => logger.warn(message, error),
  };
}
