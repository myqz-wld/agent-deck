import { randomUUID } from 'node:crypto';
import log from '@main/utils/logger';
import type { ClaudeCanUseToolHost } from './can-use-tool-core';

const logger = log.scope('claude-can-use-tool');

export const desktopClaudeCanUseToolHost: ClaudeCanUseToolHost = {
  createRequestId: () => randomUUID(),
  now: () => Date.now(),
  observeSandboxIntercept: (host) => {
    logger.info(
      `[sandbox-canusetool] SandboxNetworkAccess intercept host=${host} → auto-deny + fallback hint`,
    );
  },
};
