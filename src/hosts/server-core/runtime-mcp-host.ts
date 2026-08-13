import type { JsonValue } from '@contracts/index';

import { ServerCoreDesktopBroker } from './desktop-broker';
import { ServerCoreMcpBroker } from './mcp-broker';
import type { ServerCoreMcpSessionPort } from './mcp-session-port';
import type { ServerCoreMcpSpawnPort } from './mcp-spawn-port';
import type {
  ServerCoreMcpWorktreePort,
  ServerCoreWorktreeRuntimePort,
} from './mcp-worktree-port';
import { ServerCoreMcpPresentation } from './mcp-presentation';
import { createServerCoreMcpToolHost } from './mcp-tool-host-production';
import type {
  ServerCoreRepositoryHost,
  ServerCoreRuntimeDiagnostics,
} from './repository-host';
import type { ServerCoreRuntimeMetadataStore } from './runtime-metadata-store';
import { ServerCoreMcpHandOff } from './mcp-handoff';
import { ServerCorePlanReview, type ServerCorePlanReviewEventPort } from './mcp-plan-review';
import type { ServerCoreSessionCreateCapabilities } from './session-create-capabilities';
import type { AgentAdapter } from '@main/adapters/types';

export function createServerCoreMcpComposition(input: {
  readonly workspaceRoot: string;
  readonly privateRoots: readonly string[];
  readonly repositories: ServerCoreRepositoryHost;
  readonly metadata: ServerCoreRuntimeMetadataStore;
  readonly collaboration: ServerCoreMcpSessionPort;
  readonly spawn: ServerCoreMcpSpawnPort;
  readonly worktrees: ServerCoreMcpWorktreePort;
  readonly worktreeRuntime: ServerCoreWorktreeRuntimePort;
  readonly registry: { get(adapterId: string): AgentAdapter | undefined };
  readonly capabilities: ServerCoreSessionCreateCapabilities;
  readonly mcpEnabled: boolean;
  readonly mcpHttpEnabled: boolean;
  readonly diagnostics: ServerCoreRuntimeDiagnostics;
  readonly reviewEvents: ServerCorePlanReviewEventPort;
  readonly appendChange: (kind: string, entityId: string, payload: JsonValue) => void;
}) {
  const desktopBroker = new ServerCoreDesktopBroker();
  const reviewer = new ServerCorePlanReview({
    sessions: input.repositories.sessions,
    closeSession: (sessionId) => input.repositories.sessionManager.close(sessionId),
    registry: input.registry,
    events: input.reviewEvents,
    warn: (message) => { try { input.diagnostics.warn(message); } catch {} },
  });
  const presentations = new ServerCoreMcpPresentation({
    appendChange: input.appendChange,
    warn: (message) => {
      try { input.diagnostics.warn(message); } catch {}
    },
    reviewer,
  });
  const handoff = new ServerCoreMcpHandOff({
    workspaceRoot: input.workspaceRoot,
    sessions: input.repositories.sessions,
    sessionManager: input.repositories.sessionManager,
    registry: input.registry,
    capabilities: input.capabilities,
    collaboration: input.collaboration,
    worktrees: input.worktreeRuntime,
    desktopBroker,
    presentations,
    metadata: input.metadata,
    warn: (message) => {
      try { input.diagnostics.warn(message); } catch {}
    },
  });
  const mcpBroker = new ServerCoreMcpBroker({
    host: createServerCoreMcpToolHost({
      workspaceRoot: input.workspaceRoot,
      privateRoots: input.privateRoots,
      repositories: input.repositories,
      metadata: input.metadata,
      collaboration: input.collaboration,
      spawn: input.spawn,
      handoff,
      worktree: input.worktrees,
      browser: desktopBroker,
      presentations,
    }),
    diagnostics: input.diagnostics,
    mcpEnabled: input.mcpEnabled,
    mcpHttpEnabled: input.mcpHttpEnabled,
  });
  return Object.freeze({ desktopBroker, handoff, mcpBroker, presentations });
}
