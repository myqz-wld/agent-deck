import { normalizeCwd } from '../manager-helpers';
import log from '@main/utils/logger';

const logger = log.scope('session-manager');

export function expectPendingSdkSession(
  pendingSdkCwds: Map<string, number>,
  cwd: string,
  ttlMs: number,
): () => void {
  const key = normalizeCwd(cwd);
  const expiresAt = Date.now() + ttlMs;
  pendingSdkCwds.set(key, expiresAt);
  logger.info(`[session-mgr] expect sdk session @ ${key} (ttl ${ttlMs}ms)`);
  return () => {
    if (pendingSdkCwds.get(key) === expiresAt) {
      pendingSdkCwds.delete(key);
    }
  };
}

export function consumePendingSdkClaim(
  pendingSdkCwds: Map<string, number>,
  cwd: string,
): boolean {
  const key = normalizeCwd(cwd);
  const expiresAt = pendingSdkCwds.get(key);
  if (expiresAt && Date.now() <= expiresAt) {
    pendingSdkCwds.delete(key);
    return true;
  }
  if (expiresAt) pendingSdkCwds.delete(key);
  return false;
}
