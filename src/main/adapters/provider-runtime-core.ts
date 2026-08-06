import type { AgentAdapter, AdapterContext } from './types';
import type { AdapterInitResult } from './registry-core';

export type ProviderSessionClose = (
  agentId: string,
  sessionId: string,
) => Promise<void>;

export type ProviderSessionRename = (
  agentId: string,
  fromId: string,
  toId: string,
) => void;

export interface ProviderRuntimeRegistryPort {
  register(adapter: AgentAdapter): void;
  get(id: string): AgentAdapter | undefined;
  initAll(context: AdapterContext): Promise<AdapterInitResult[]>;
}

export interface ProviderRuntimeCompositionHost {
  readonly registry: ProviderRuntimeRegistryPort;
  readonly adapters: readonly AgentAdapter[];
  installSessionClose(handler: ProviderSessionClose): void;
  installSessionRename(handler: ProviderSessionRename): void;
  renameLiveSession(
    agentId: string,
    adapter: AgentAdapter | undefined,
    fromId: string,
    toId: string,
  ): void;
  reportAdapterInitFailure(result: AdapterInitResult): void;
}

/**
 * Registers and starts the concrete provider set, then installs repository-to-runtime lifecycle
 * hooks. The owning host supplies adapters, repositories, diagnostics, and any provider-specific
 * live-session rename implementation.
 */
export async function initializeProviderRuntimeCore(
  host: ProviderRuntimeCompositionHost,
  context: AdapterContext,
): Promise<AdapterInitResult[]> {
  for (const adapter of host.adapters) host.registry.register(adapter);

  const results = await host.registry.initAll(context);
  for (const result of results) {
    if (!result.ok) host.reportAdapterInitFailure(result);
  }

  host.installSessionClose(async (agentId, sessionId) => {
    const adapter = host.registry.get(agentId);
    if (!adapter?.closeSession) return;
    await adapter.closeSession(sessionId);
  });
  host.installSessionRename((agentId, fromId, toId) => {
    host.renameLiveSession(
      agentId,
      host.registry.get(agentId),
      fromId,
      toId,
    );
  });

  return results;
}
