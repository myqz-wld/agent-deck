import type { JsonValue } from '@contracts/index';
import type { SessionAdapterId, SessionRecord } from '@shared/types';

import type { ServerCoreIssueRepository } from './issue-repository';
import type { ServerCoreDesktopBrokerPort } from './desktop-broker-port';
import type { ServerCoreMcpSessionPort } from './mcp-session-port';
import type { ServerCoreMcpSpawnPort } from './mcp-spawn-port';
import type { ServerCoreMcpWorktreePort } from './mcp-worktree-port';
import type { ServerCoreMcpPresentationPort } from './mcp-presentation-port';
import type { ServerCoreMcpHandOffPort } from './mcp-handoff-port';
import type { ServerCoreSessionTaskReadRepository } from './session-task-read-repository';

export interface ServerCoreMcpCaller {
  readonly sessionId: string;
  readonly adapterId: SessionAdapterId;
  readonly session: SessionRecord;
}

export interface ServerCoreMcpToolHost {
  readonly workspaceRoot: string;
  readonly privateRoots: readonly string[];
  readonly sessions: {
    get(sessionId: string): SessionRecord | null;
  };
  readonly tasks: ServerCoreSessionTaskReadRepository;
  readonly issues: ServerCoreIssueRepository;
  readonly collaboration: ServerCoreMcpSessionPort;
  readonly spawn: ServerCoreMcpSpawnPort;
  readonly handoff: ServerCoreMcpHandOffPort;
  readonly worktree: ServerCoreMcpWorktreePort;
  readonly browser: Pick<ServerCoreDesktopBrokerPort, 'invoke'>;
  readonly presentations: Pick<
    ServerCoreMcpPresentationPort,
    'requestDiff' | 'requestPlan'
  >;
  readonly teams: {
    activeTeamIds(sessionId: string): readonly string[];
  };
  readonly ownership: {
    isCurrentOwner(historicalSessionId: string | null, callerSessionId: string): boolean;
  };
  readonly metadata: {
    appendChange(kind: string, entityId: string | null, payload: JsonValue): number;
  };
}

export interface ServerCoreMcpCallContext {
  readonly host: ServerCoreMcpToolHost;
  readonly callerSessionId: () => string;
  readonly adapterId: SessionAdapterId;
}

export function requireServerCoreMcpCaller(
  context: ServerCoreMcpCallContext,
): ServerCoreMcpCaller {
  const sessionId = context.callerSessionId();
  const session = context.host.sessions.get(sessionId);
  if (!session || session.lifecycle === 'closed' || session.archivedAt !== null) {
    throw new Error('Authenticated MCP caller is unavailable');
  }
  if (session.agentId !== context.adapterId) {
    throw new Error('Authenticated MCP adapter identity changed');
  }
  return Object.freeze({ sessionId, adapterId: context.adapterId, session });
}

export function activeTeamIds(
  host: ServerCoreMcpToolHost,
  sessionId: string,
): string[] {
  return [...new Set(host.teams.activeTeamIds(sessionId))];
}

export function isActiveTeamMember(
  host: ServerCoreMcpToolHost,
  sessionId: string,
  teamId: string,
): boolean {
  return activeTeamIds(host, sessionId).includes(teamId);
}
