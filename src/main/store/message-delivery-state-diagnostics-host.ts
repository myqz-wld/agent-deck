import log from '@main/utils/logger';

import { setMessageDeliveryStateDiagnostics } from './message-delivery-state-diagnostics-core';

const logger = log.scope('store-message-delivery');

export function installDesktopMessageDeliveryStateDiagnostics(): void {
  setMessageDeliveryStateDiagnostics({
    warn: (message) => logger.warn(message),
  });
}
