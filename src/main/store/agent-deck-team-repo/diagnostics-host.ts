import log from '@main/utils/logger';

import { setAgentDeckTeamRepositoryDiagnostics } from './diagnostics-core';

const logger = log.scope('agent-deck-team-repo-types');

export function installDesktopAgentDeckTeamRepositoryDiagnostics(): void {
  setAgentDeckTeamRepositoryDiagnostics({
    warn: (message) => logger.warn(message),
  });
}
