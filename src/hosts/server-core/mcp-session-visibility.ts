import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { GetSessionResult } from '@main/agent-deck-mcp/tools/schemas';
import type { AgentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import type { SessionRecord } from '@shared/types';

const MAX_CHAIN_DEPTH = 1_024;

export interface ServerCoreMcpSessionVisibilityPorts {
  readonly workspaceRoot: string;
  readonly sessions: { get(sessionId: string): SessionRecord | null };
  readonly teams: Pick<
    AgentDeckTeamRepo,
    'findActiveMembershipsBySessionIds' | 'findSharedActiveTeams'
  >;
  readonly successor: (sessionId: string) => string | null;
}

function inside(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === '' || (
    child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
  );
}

export function projectServerCoreMcpCwd(workspaceRoot: string, cwd: string): string {
  const root = resolve(workspaceRoot);
  const target = resolve(cwd);
  if (!inside(root, target)) return '[outside Workspace]';
  const token = relative(root, target).split(sep).join('/');
  return token || '.';
}

export function projectServerCoreMcpSession(
  ports: ServerCoreMcpSessionVisibilityPorts,
  session: SessionRecord,
): GetSessionResult {
  const memberships = ports.teams.findActiveMembershipsBySessionIds([session.id])
    .get(session.id) ?? [];
  return {
    sessionId: session.id,
    adapter: session.agentId,
    gateway: session.agentId === 'claude-code' ? session.runtimeProvider ?? null : null,
    provider: session.agentId === 'codex-cli' ? session.runtimeProvider ?? null : null,
    cwd: projectServerCoreMcpCwd(ports.workspaceRoot, session.cwd),
    lifecycle: session.lifecycle,
    title: session.title || null,
    lastEventAt: session.lastEventAt ?? null,
    teamName: memberships[0]?.teamName ?? null,
    teams: memberships.map(({ teamId, teamName }) => ({ teamId, teamName })),
    spawnedBy: session.spawnedBy ?? null,
    spawnDepth: session.spawnDepth ?? 0,
  };
}

function forwardLineage(
  sessionId: string,
  successor: (sessionId: string) => string | null,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let current: string | null = sessionId;
  while (current && result.length < MAX_CHAIN_DEPTH && !seen.has(current)) {
    result.push(current);
    seen.add(current);
    current = successor(current);
  }
  return result;
}

function isSpawnAncestor(
  ports: ServerCoreMcpSessionVisibilityPorts,
  ancestorId: string,
  descendantId: string,
): boolean {
  const seen = new Set<string>();
  let current: string | null = descendantId;
  for (let depth = 0; current && depth < MAX_CHAIN_DEPTH; depth += 1) {
    if (current === ancestorId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = ports.sessions.get(current)?.spawnedBy ?? null;
  }
  return false;
}

export function areServerCoreMcpSessionsRelated(
  ports: ServerCoreMcpSessionVisibilityPorts,
  callerSessionId: string,
  targetSessionId: string,
): boolean {
  if (callerSessionId === targetSessionId) return true;
  const callers = forwardLineage(callerSessionId, ports.successor);
  const targets = forwardLineage(targetSessionId, ports.successor);
  for (const caller of callers) {
    for (const target of targets) {
      if (
        caller === target ||
        isSpawnAncestor(ports, caller, target) ||
        isSpawnAncestor(ports, target, caller)
      ) return true;
    }
  }
  return ports.teams.findSharedActiveTeams(callerSessionId, targetSessionId).length > 0;
}
