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
  type ServerCoreMcpSessionVisibilityPorts,
} from './mcp-session-visibility';
import { projectSessionEvents } from './session-event-projection';

const MAX_SESSION_SCAN = 10_000;

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
    const base = this.listBase(args);
    const all = args.spawnedByFilter
      ? base
      : base.filter((session) =>
        areServerCoreMcpSessionsRelated(this.visibility, callerSessionId, session.id));
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 50;
    const page = all.slice(offset, offset + limit);
    return {
      total: page.length,
      hasMore: all.length > offset + limit,
      sessions: page.map((session) => projectServerCoreMcpSession(this.visibility, session)),
    };
  }

  get(callerSessionId: string, sessionId: string): GetSessionResult {
    this.requireCaller(callerSessionId);
    const target = this.options.sessions.get(sessionId);
    if (!target) throw new Error(`Session ${sessionId} was not found`);
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
    const target = this.options.sessions.get(args.sessionId) ??
      this.options.sessions.findByCliSessionId(args.sessionId);
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
  ): Promise<ShutdownSessionResult> {
    this.requireCaller(callerSessionId);
    if (args.sessionId === callerSessionId) throw new Error('Cannot shut down the caller session');
    const target = this.options.sessions.get(args.sessionId);
    if (!target) throw new Error(`Session ${args.sessionId} was not found`);
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

  private listBase(args: ListSessionsArgs): SessionRecord[] {
    const status = args.statusFilter ?? 'active';
    const common = [
      args.spawnedByFilter,
      args.adapterFilter,
    ] as const;
    if (status === 'active' || status === 'dormant') {
      return this.options.sessions.listActiveAndDormant(
        MAX_SESSION_SCAN + 1,
        0,
        status,
        ...common,
      );
    }
    if (status === 'closed') {
      return this.options.sessions.listHistory({
        limit: MAX_SESSION_SCAN + 1,
        offset: 0,
        ...(common[0] ? { spawnedBy: common[0] } : {}),
        ...(common[1] ? { agentId: common[1] } : {}),
      });
    }
    const live = this.options.sessions.listActiveAndDormant(
      MAX_SESSION_SCAN + 1,
      0,
      undefined,
      ...common,
    );
    const history = this.options.sessions.listHistory({
      limit: MAX_SESSION_SCAN + 1,
      offset: 0,
      ...(common[0] ? { spawnedBy: common[0] } : {}),
      ...(common[1] ? { agentId: common[1] } : {}),
    });
    return [...live, ...history]
      .sort((left, right) => (right.lastEventAt ?? 0) - (left.lastEventAt ?? 0))
      .slice(0, MAX_SESSION_SCAN + 1);
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
    const samePair =
      (original.fromSessionId === callerSessionId && original.toSessionId === targetSessionId) ||
      (original.fromSessionId === targetSessionId && original.toSessionId === callerSessionId);
    if (!samePair) throw new Error('Teamless reply belongs to another session pair');
  }
}
