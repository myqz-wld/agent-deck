import { sessionRepo } from '@main/store/session-repo';
import { settingsStore } from '@main/store/settings-store';
import { resolveClaudeGatewayProfile } from '../gateway-profiles';
import type { ClaudeCreateSessionHost } from './session-defaults-core';

export const desktopClaudeSessionDefaultsHost: ClaudeCreateSessionHost = {
  readPersistedSession: (sessionId) => sessionRepo.get(sessionId),
  readSandboxDefault: () => settingsStore.get('claudeCodeSandbox'),
  resolveGatewayProfile: (gateway) => resolveClaudeGatewayProfile(gateway),
  deleteTransientSession: (sessionId) => sessionRepo.delete(sessionId),
};
