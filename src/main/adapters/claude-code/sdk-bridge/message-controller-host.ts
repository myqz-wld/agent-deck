import { guardHandOffSourceIngress } from '@main/session/hand-off/ingress-guard';
import log from '@main/utils/logger';
import type { ClaudeMessageControllerHost } from './message-controller-core';

const logger = log.scope('claude-bridge');

export const desktopClaudeMessageControllerHost: ClaudeMessageControllerHost = {
  guardSourceIngress: (input) => guardHandOffSourceIngress(input),
  acceptedEnqueueEventFailed: (idempotencyKey, error) => {
    logger.warn(`[claude-bridge] accepted enqueue event failed key=${idempotencyKey}`, error);
  },
  now: () => Date.now(),
};
