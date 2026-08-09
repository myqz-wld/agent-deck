import { findSessionHandOffSuccessor } from '@main/store/session-handoff-alias-repo';

import type { ServerCoreMcpToolHost } from './mcp-tool-host';
import type { ServerCoreMcpSessionPort } from './mcp-session-port';
import type { ServerCoreMcpSpawnPort } from './mcp-spawn-port';
import type { ServerCoreMcpWorktreePort } from './mcp-worktree-port';
import type { ServerCoreRepositoryHost } from './repository-host';
import type { ServerCoreRuntimeMetadataStore } from './runtime-metadata-store';
import type { ServerCoreDesktopBrokerPort } from './desktop-broker-port';
import type { ServerCoreMcpPresentationPort } from './mcp-presentation-port';
import type { ServerCoreMcpHandOffPort } from './mcp-handoff-port';

const MAX_HANDOFF_DEPTH = 1_024;

function isCurrentOwner(
  historicalSessionId: string | null,
  callerSessionId: string,
): boolean {
  if (!historicalSessionId) return false;
  const seen = new Set<string>();
  let current = historicalSessionId;
  for (let depth = 0; depth < MAX_HANDOFF_DEPTH; depth += 1) {
    if (seen.has(current)) return false;
    seen.add(current);
    const successor = findSessionHandOffSuccessor(current);
    if (!successor) return current === callerSessionId;
    current = successor;
  }
  return false;
}

export function createServerCoreMcpToolHost(input: {
  readonly workspaceRoot: string;
  readonly privateRoots: readonly string[];
  readonly repositories: ServerCoreRepositoryHost;
  readonly metadata: ServerCoreRuntimeMetadataStore;
  readonly collaboration: ServerCoreMcpSessionPort;
  readonly spawn: ServerCoreMcpSpawnPort;
  readonly handoff: ServerCoreMcpHandOffPort;
  readonly worktree: ServerCoreMcpWorktreePort;
  readonly browser: Pick<ServerCoreDesktopBrokerPort, 'invoke'>;
  readonly presentations: Pick<
    ServerCoreMcpPresentationPort,
    'requestDiff' | 'requestPlan'
  >;
}): ServerCoreMcpToolHost {
  return Object.freeze({
    workspaceRoot: input.workspaceRoot,
    privateRoots: Object.freeze([...input.privateRoots]),
    sessions: input.repositories.sessions,
    tasks: input.repositories.tasks,
    issues: input.repositories.issues,
    collaboration: input.collaboration,
    spawn: input.spawn,
    handoff: input.handoff,
    worktree: input.worktree,
    browser: input.browser,
    presentations: input.presentations,
    teams: Object.freeze({
      activeTeamIds: (sessionId: string) => input.repositories.tasks.activeTeamIds(sessionId),
    }),
    ownership: Object.freeze({ isCurrentOwner }),
    metadata: input.metadata,
  });
}
