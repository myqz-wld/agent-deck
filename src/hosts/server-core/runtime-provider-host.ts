import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import type {
  ProviderRuntimeCompositionHost,
  ProviderRuntimeRegistryPort,
} from '@main/adapters/provider-runtime-core';
import type { AgentAdapter } from '@main/adapters/types';

import type { ServerCoreDesktopBrokerPort } from './desktop-broker-port';
import type { ServerCoreWorktreeRuntimePort } from './mcp-worktree-port';
import type { ServerCoreMcpPresentationPort } from './mcp-presentation-port';
import type { ServerCoreProviderRenameBus } from './provider-host-common';
import type { ServerCoreProviderBrowserRuntimePort } from './browser-runtime';
import type {
  ServerCoreRepositoryHost,
  ServerCoreRuntimeDiagnostics,
} from './repository-host';

function renameCodexLiveSession(
  agentId: string,
  adapter: AgentAdapter | undefined,
  fromId: string,
  toId: string,
): void {
  if (agentId !== 'codex-cli') return;
  mcpSessionTokenMap.rename(fromId, toId);
  const bridge = (adapter as {
    bridge?: { renameCodexInstance?: (from: string, to: string) => void } | null;
  } | undefined)?.bridge;
  bridge?.renameCodexInstance?.(fromId, toId);
}

/** Provider lifecycle hooks shared by all concrete headless adapters. */
export function createServerCoreProviderCompositionHost(input: {
  readonly registry: ProviderRuntimeRegistryPort;
  readonly adapters: readonly AgentAdapter[];
  readonly repositories: ServerCoreRepositoryHost;
  readonly desktopBroker: Pick<ServerCoreDesktopBrokerPort, 'releaseSession' | 'renameSession'>;
  readonly browserRuntime: Pick<
    ServerCoreProviderBrowserRuntimePort,
    'renameSession' | 'revokeSession'
  >;
  readonly presentations: Pick<ServerCoreMcpPresentationPort, 'releaseSession' | 'renameSession'>;
  readonly worktrees: Pick<ServerCoreWorktreeRuntimePort, 'renameSession'>;
  readonly renames: ServerCoreProviderRenameBus;
  readonly diagnostics: ServerCoreRuntimeDiagnostics;
}): ProviderRuntimeCompositionHost {
  return {
    registry: input.registry,
    adapters: input.adapters,
    installSessionClose: (handler) => input.repositories.sessionManager.installSessionClose(
      async (agentId, sessionId) => {
        try { await handler(agentId, sessionId); }
        finally {
          input.browserRuntime.revokeSession(sessionId);
          input.desktopBroker.releaseSession(sessionId);
          input.presentations.releaseSession(sessionId);
        }
      },
    ),
    installSessionRename: (handler) =>
      input.repositories.sessionManager.installSessionRename(handler),
    renameLiveSession: (agentId, adapter, fromId, toId) => {
      renameCodexLiveSession(agentId, adapter, fromId, toId);
      input.worktrees.renameSession(fromId, toId);
      input.browserRuntime.renameSession(fromId, toId);
      input.desktopBroker.renameSession(fromId, toId);
      input.presentations.renameSession(fromId, toId);
      input.renames.emit({ from: fromId, to: toId });
    },
    reportAdapterInitFailure: (result) => {
      input.diagnostics.warn('Provider adapter initialization failed', {
        adapterId: result.id,
      });
    },
  };
}
