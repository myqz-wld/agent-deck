import log from '@main/utils/logger';
import { AGENT_ID } from './constants';
import type { ClaudeStreamWaitHost } from './stream-wait-core';

const logger = log.scope('claude-stream');

export const desktopClaudeStreamWaitHost: ClaudeStreamWaitHost = {
  agentId: AGENT_ID,
  now: () => Date.now(),
  warn: (message, error) => logger.warn(message, error),
};
