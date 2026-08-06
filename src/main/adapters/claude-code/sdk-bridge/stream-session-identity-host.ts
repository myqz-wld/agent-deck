import log from '@main/utils/logger';
import type { ClaudeStreamSessionIdentityHost } from './stream-session-identity-core';
import type { ClaudeSessionManagerPort } from '../session-manager-core';

const logger = log.scope('claude-stream');

export function createDesktopClaudeStreamSessionIdentityHost(
  sessionManager: Pick<ClaudeSessionManagerPort, 'renameSdkSession' | 'updateCliSessionId'>,
): ClaudeStreamSessionIdentityHost {
  return {
    warn: (message) => logger.warn(message),
    renameSdkSession: (fromSessionId, toSessionId) =>
      sessionManager.renameSdkSession(fromSessionId, toSessionId),
    updateCliSessionId: (applicationSid, cliSessionId) =>
      sessionManager.updateCliSessionId(applicationSid, cliSessionId),
  };
}
