import log from '@main/utils/logger';

import type {
  GrokBridgeDiagnosticLogger,
  GrokBridgeDiagnostics,
} from './bridge-diagnostics-core';

const scoped = new Map<string, GrokBridgeDiagnosticLogger>();

export const desktopGrokBridgeDiagnostics: GrokBridgeDiagnostics = {
  scope: (name) => {
    const existing = scoped.get(name);
    if (existing) return existing;
    const logger = log.scope(name);
    const created: GrokBridgeDiagnosticLogger = Object.freeze({
      debug: (message, ...details) => logger.debug(message, ...details),
      info: (message, ...details) => logger.info(message, ...details),
      warn: (message, ...details) => logger.warn(message, ...details),
    });
    scoped.set(name, created);
    return created;
  },
};
