import type {
  GetSessionResult,
  ListSessionEventsArgs,
  ListSessionEventsResult,
  ListSessionsArgs,
  ListSessionsResult,
  SendMessageArgs,
  SendMessageResult,
  ShutdownSessionArgs,
  ShutdownSessionResult,
} from '@main/agent-deck-mcp/tools/schemas';
import type { AgentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import type { AgentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
import type { SessionRecord, StoredAgentEvent } from '@shared/types';
import { retireClosedSessionRuntime } from '@main/adapters/closed-session-runtime-retirement';

import { ServerCoreMcpMessageDispatcher } from './mcp-message-dispatcher';
import type { ServerCoreMcpSessionPort } from './mcp-session-port';
import {
  areServerCoreMcpSessionsRelated,
  projectServerCoreMcpSession,
  projectServerCoreMcpCwd,
  type ServerCoreMcpSessionVisibilityPorts,
} from './mcp-session-visibility';
import { projectSessionEvents } from './session-event-projection';
import { authorizeSessionShutdown, type SessionShutdownAuthority } from '@main/agent-deck-mcp/session-shutdown-authority';
import { collectSessionDirectory } from '@main/agent-deck-mcp/session-directory';


export interface ServerCoreMcpSessionRepositoryPort {
  get(sessionId: string): SessionRecord | null;
  findByCliSessionId(cliSessionId: string): SessionRecord | null;
  listActiveAndDormant(
    limit: number,
    offset: number,
    lifecycle?: 'active' | 'dormant',
    spawnedBy?: string,
    agentId?: string,
  ): SessionRecord[];
  listHistory(options: {
    limit: number;
    offset: number;
    spawnedBy?: string;
    agentId?: string;
  }): SessionRecord[];
}

export interface ServerCoreMcpSessionEventPort {
  listValidForSession(
    sessionId: string,
    limit: number,
    offset: number,
  ): StoredAgentEvent[];
}

export interface ServerCoreMcpSessionCollaborationOptions {
  readonly workspaceRoot: string;
  readonly privateRoots: readonly string[];
  readonly sessions: ServerCoreMcpSessionRepositoryPort;
  readonly events: ServerCoreMcpSessionEventPort;
  readonly teams: AgentDeckTeamRepo;
  readonly messages: AgentDeckMessageRepo;
  readonly successor: (sessionId: string) => string | null;
  readonly ownershipLineage?: (sessionId: string) => readonly string[];
  readonly requestShutdownApproval?: SessionShutdownAuthority['request'];
  readonly closeSession: (sessionId: string) => Promise<void>;
  readonly adapter: ServerCoreMcpMessageDispatcherOptions['adapter'];
  readonly appendChange: ServerCoreMcpMessageDispatcherOptions['appendChange'];
  readonly now?: () => number;
}

type ServerCoreMcpMessageDispatcherOptions = ConstructorParameters<
  typeof ServerCoreMcpMessageDispatcher
>[0];

/** Session collaboration port shared by in-process Claude and token-authenticated MCP clients. */
export class ServerCoreMcpSessionCollaboration implements ServerCoreMcpSessionPort {
  private readonly visibility: ServerCoreMcpSessionVisibilityPorts;
  private readonly dispatcher: ServerCoreMcpMessageDispatcher;

  constructor(private readonly options: ServerCoreMcpSessionCollaborationOptions) {
    this.visibility = Object.freeze({
      workspaceRoot: options.workspaceRoot,
      sessions: options.sessions,
      teams: options.teams,
      successor: options.successor,
      ownershipLineage: options.ownershipLineage,
    });
    this.dispatcher = new ServerCoreMcpMessageDispatcher({
      sessions: options.sessions,
      teams: options.teams,
      messages: options.messages,
      adapter: options.adapter,
      appendChange: options.appendChange,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  start(): Promise<void> {
    return this.dispatcher.start();
  }

  stop(): Promise<void> {
    return this.dispatcher.stop();
  }

  drainForHandOff(sessionId: string, timeoutMs?: number): Promise<boolean> {
    return this.dispatcher.drainForHandOff(sessionId, timeoutMs);
  }

  list(callerSessionId: string, args: ListSessionsArgs): ListSessionsResult {
    this.requireCaller(callerSessionId);
    const { page, hasMore } = collectSessionDirectory(this.options.sessions,
      { ...args, cwdFilter: undefined }, (session) => {
        const cwd = projectServerCoreMcpCwd(this.options.workspaceRoot, session.cwd);
        return cwd !== '[outside Workspace]' &&
          (!args.cwdFilter || cwd.includes(args.cwdFilter)) &&
          (args.scope === 'all' ||
            areServerCoreMcpSessionsRelated(this.visibility, callerSessionId, session.id));
      });
    return { total: page.length, hasMore,
      sessions: page.map((session) => projectServerCoreMcpSession(this.visibility, session)) };
  }

  get(callerSessionId: string, sessionId: string): GetSessionResult {
    this.requireCaller(callerSessionId);
    const target = this.options.sessions.get(sessionId);
    if (!target || target.hiddenFromHistory || projectServerCoreMcpCwd(this.options.workspaceRoot, target.cwd) === '[outside Workspace]') throw new Error(`Session ${sessionId} was not found in the metadata directory`);
    return projectServerCoreMcpSession(this.visibility, target);
  }

  listEvents(
    callerSessionId: string,
    args: ListSessionEventsArgs,
  ): ListSessionEventsResult {
    this.requireCaller(callerSessionId);
    const target = this.options.sessions.get(args.sessionId);
    if (!target) throw new Error(`Session ${args.sessionId} was not found`);
    this.requireRelated(callerSessionId, target.id);
    const limit = args.limit ?? 100;
    const rows = this.options.events.listValidForSession(
      target.id,
      limit + 1,
      args.offset ?? 0,
    );
    const projected = projectSessionEvents(rows, target, limit, {
      workspaceRoot: this.options.workspaceRoot,
      privateRoots: this.options.privateRoots,
    });
    return {
      sessionId: target.id,
      hasMore: projected.truncated,
      events: projected.events,
    };
  }

  send(callerSessionId: string, args: SendMessageArgs): SendMessageResult {
    const caller = this.requireCaller(callerSessionId);
    const requested = this.options.sessions.get(args.sessionId) ??
      this.options.sessions.findByCliSessionId(args.sessionId);
    const canonicalId = this.canonicalSessionId(requested?.id ?? args.sessionId);
    const target = this.options.sessions.get(canonicalId);
    if (!target) throw new Error(`Session ${args.sessionId} was not found`);
    if (target.id === caller.id) throw new Error('Cannot send a message to the caller session');
    if (target.lifecycle === 'closed' || target.archivedAt !== null) {
      throw new Error('Target session is unavailable');
    }
    const teamId = this.resolveTeam(caller.id, target.id, args.teamId);
    this.validateReply(caller.id, target.id, teamId, args.replyToMessageId);
    const result = this.dispatcher.enqueue({
      teamId,
      fromSessionId: caller.id,
      toSessionId: target.id,
      body: args.text,
      replyToMessageId: args.replyToMessageId ?? null,
    });
    if (!result.ok) {
      throw new Error(`Message rate limit exceeded; retry after ${result.retryAfterMs}ms`);
    }
    return {
      sessionId: target.id,
      teamId,
      messageId: result.message.id,
      replyToMessageId: result.message.replyToMessageId,
      sentAt: result.message.sentAt,
      queued: true,
    };
  }

  async shutdown(
    callerSessionId: string,
    args: ShutdownSessionArgs,
    signal?: AbortSignal,
  ): Promise<ShutdownSessionResult> {
    this.requireCaller(callerSessionId);
    const requested = this.options.sessions.get(args.sessionId);
    if (requested && projectServerCoreMcpCwd(this.options.workspaceRoot, requested.cwd) === '[outside Workspace]') {
      throw new Error('Shutdown target is outside the Core Workspace');
    }
    const consume = await authorizeSessionShutdown(callerSessionId, args.sessionId, {
      get: (id) => this.options.sessions.get(id),
      successor: (id) => this.options.successor(id),
      lineage: (id) => this.options.ownershipLineage?.(id) ?? [id],
      request: this.options.requestShutdownApproval ?? (() => Promise.reject(new Error('User confirmation is unavailable; nothing was closed'))),
      displayCwd: (row) => projectServerCoreMcpSession(this.visibility, row).cwd,
    }, signal);
    const target = consume();
    const alreadyClosed = target.lifecycle === 'closed';
    if (alreadyClosed) {
      await retireClosedSessionRuntime(
        this.options.adapter(target.agentId),
        target.id,
      );
    } else {
      await this.options.closeSession(target.id);
    }
    return { sessionId: target.id, lifecycle: 'closed', alreadyClosed };
  }

  private canonicalSessionId(id: string): string {
    const seen = new Set<string>();
    for (let depth = 0; depth < 1024; depth++) {
      if (seen.has(id)) throw new Error('Session handoff ownership cycle');
      seen.add(id);
      const next = this.options.successor(id);
      if (!next) return id;
      id = next;
    }
    throw new Error('Session handoff ownership exceeds its bound');
  }

  private requireCaller(sessionId: string): SessionRecord {
    const session = this.options.sessions.get(sessionId);
    if (!session || session.lifecycle === 'closed' || session.archivedAt !== null) {
      throw new Error('Authenticated MCP caller is unavailable');
    }
    return session;
  }

  private requireRelated(callerSessionId: string, targetSessionId: string): void {
    if (!areServerCoreMcpSessionsRelated(this.visibility, callerSessionId, targetSessionId)) {
      throw new Error('Target session is outside the caller collaboration scope');
    }
  }

  private resolveTeam(
    callerSessionId: string,
    targetSessionId: string,
    requested: string | undefined,
  ): string | null {
    const shared = this.options.teams.findSharedActiveTeams(callerSessionId, targetSessionId);
    if (requested !== undefined) {
      if (!shared.includes(requested)) throw new Error('Requested team is not shared and active');
      return requested;
    }
    if (shared.length > 1) throw new Error('Multiple teams are shared; teamId is required');
    return shared[0] ?? null;
  }

  private validateReply(
    callerSessionId: string,
    targetSessionId: string,
    teamId: string | null,
    replyToMessageId: string | undefined,
  ): void {
    if (!replyToMessageId) return;
    const original = this.dispatcher.get(replyToMessageId);
    if (!original || original.teamId !== teamId) {
      throw new Error('Reply message is unavailable in the selected team scope');
    }
    if (teamId !== null) return;
    const from = this.canonicalSessionId(original.fromSessionId);
    const to = this.canonicalSessionId(original.toSessionId);
    const samePair =
      (from === callerSessionId && to === targetSessionId) ||
      (from === targetSessionId && to === callerSessionId);
    if (!samePair) throw new Error('Teamless reply belongs to another session pair');
  }
}
