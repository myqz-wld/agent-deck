import type { AdapterRegistryClass } from '@main/adapters/registry-core';
import type { ServerCoreRepositoryHost } from './repository-host';

export function createServerCoreSessionRollback(
  repositories: ServerCoreRepositoryHost,
  registry: AdapterRegistryClass,
): (adapterId: string, sessionId: string) => Promise<void> {
  return async (adapterId, sessionId) => {
    const record = repositories.sessions.get(sessionId);
    if (record && record.agentId !== adapterId) {
      throw new Error('Created session rollback adapter identity changed');
    }
    const adapter = registry.get(adapterId);
    if (!adapter?.closeSessionForRollback) {
      throw new Error('Adapter does not provide strict session rollback');
    }
    await adapter.closeSessionForRollback(sessionId);
    repositories.sessionManager.discardAfterProviderRollback(sessionId);
    if (repositories.sessions.get(sessionId)) {
      throw new Error('Created session rollback durable cleanup did not complete');
    }
  };
}
