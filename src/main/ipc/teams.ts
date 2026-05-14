/**
 * R3.E8 (PR-B) Universal Team Backend IPC handlers — replace 老 team:* channel set.
 *
 * 老 channel（TeamList / TeamGet / TeamSubscribe / TeamForceCleanup / TeamRespondPermission /
 * TeamListPendingPermissions）全删；UI 重写后只走新 agent-deck-team:* / agent-deck-message:* 通道。
 *
 * 详 docs/agent-deck-team-protocol.md §6.4。
 *
 * 留 SummarizerLastErrors handler（与 team 无关，原 teams.ts 顺带住的）。
 */
import { IpcInvoke } from '@shared/ipc-channels';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { agentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
import { taskRepo } from '@main/store/task-repo';
import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { eventRepo } from '@main/store/event-repo';
import { eventBus } from '@main/event-bus';
import { summarizer } from '@main/session/summarizer';
import { enqueueAgentDeckMessage } from '@main/teams/universal-message-watcher';
import type {
  AgentDeckMessage,
  AgentDeckTeam,
  AgentDeckTeamMember,
  AgentDeckTeamMemberRole,
  AgentEvent,
  TaskRecord,
} from '@shared/types';
import { on, IpcInputError } from './_helpers';

function parseId(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new IpcInputError(field, `${field} required (non-empty string)`);
  }
  const trimmed = raw.trim();
  if (trimmed.length > 256) {
    throw new IpcInputError(field, `${field} too long (max 256 chars)`);
  }
  return trimmed;
}

export function registerTeamsIpc(): void {
  // Summarizer 诊断（与 team 无关，原 teams.ts 顺带住的）
  on(IpcInvoke.SummarizerLastErrors, () => summarizer.getLastErrors());

  // ───────── R3.E8 Universal Team Backend ─────────

  // List：默认隐藏 archived，UI 想看 archived 时传 args.includeArchived = true。
  // 含 members（TeamHub 渲染 memberCount + lastEventAt 需要；CHANGELOG_105 #7 修复
  // 「0 members 但最近活跃」bug —— 旧实现只 list 基础 team 不挂 members）。
  on(
    IpcInvoke.AgentDeckTeamList,
    async (
      _e,
      opts,
    ): Promise<(AgentDeckTeam & { members: AgentDeckTeamMember[] })[]> => {
      const includeArchived =
        opts && typeof opts === 'object' && 'includeArchived' in opts
          ? Boolean((opts as { includeArchived: unknown }).includeArchived)
          : false;
      const teams = agentDeckTeamRepo.list({ activeOnly: !includeArchived, limit: 200 });
      // N+1 query: list 上限 200 + per-team 单 SQL,可接受(team list 渲染不高频)。
      // 真有性能瓶颈再考虑 listWithMembers JOIN 单 SQL 优化。
      return teams.map((t) => ({
        ...t,
        members: agentDeckTeamRepo.listActiveMembers(t.id),
      }));
    },
  );

  // Get：含 members + 最近 100 条 messages
  on(
    IpcInvoke.AgentDeckTeamGet,
    async (
      _e,
      teamIdRaw,
    ): Promise<
      | (AgentDeckTeam & {
          members: AgentDeckTeamMember[];
          recentMessages: AgentDeckMessage[];
        })
      | null
    > => {
      const teamId = parseId(teamIdRaw, 'teamId');
      const team = agentDeckTeamRepo.getWithMembers(teamId);
      if (!team) return null;
      const recentMessages = agentDeckMessageRepo.listByTeam(teamId, { limit: 100 });
      return { ...team, recentMessages };
    },
  );

  // plan team-cohesion-fix-20260513 Phase C：Get-full 4 sections snapshot。
  // lineage / pending 由 renderer 自拼（lineage 走 sessions Map.spawnedBy；pending 走 store
  // pendingXBySession ∩ member sessionIds），避免 main 端重复 SQL + 与 PendingTab 一致。
  on(
    IpcInvoke.AgentDeckTeamGetFull,
    async (
      _e,
      teamIdRaw,
    ): Promise<
      | (AgentDeckTeam & {
          members: AgentDeckTeamMember[];
          recentEvents: (AgentEvent & { id: number })[];
          tasks: TaskRecord[];
          recentMessages: AgentDeckMessage[];
        })
      | null
    > => {
      const teamId = parseId(teamIdRaw, 'teamId');
      const team = agentDeckTeamRepo.getWithMembers(teamId);
      if (!team) return null;
      const recentEvents = eventRepo.findTeamEvents(teamId, 50);
      const tasks = taskRepo.list({ teamId, limit: 200 });
      const recentMessages = agentDeckMessageRepo.listByTeam(teamId, { limit: 100 });
      return { ...team, recentEvents, tasks, recentMessages };
    },
  );

  // Create
  on(
    IpcInvoke.AgentDeckTeamCreate,
    async (_e, input): Promise<AgentDeckTeam> => {
      if (!input || typeof input !== 'object') {
        throw new IpcInputError('input', 'input must be { name, metadata? }');
      }
      const { name, metadata } = input as { name?: unknown; metadata?: unknown };
      if (typeof name !== 'string' || !name.trim()) {
        throw new IpcInputError('name', 'name required (non-empty string)');
      }
      const trimmed = name.trim();
      if (trimmed.length > 128) {
        throw new IpcInputError('name', 'name too long (max 128 chars)');
      }
      const meta =
        metadata && typeof metadata === 'object' && !Array.isArray(metadata)
          ? (metadata as Record<string, unknown>)
          : {};
      const team = agentDeckTeamRepo.create({ name: trimmed, metadata: { source: 'ui', ...meta } });
      eventBus.emit('agent-deck-team-created', team);
      return team;
    },
  );

  // Archive
  on(
    IpcInvoke.AgentDeckTeamArchive,
    async (_e, teamIdRaw): Promise<AgentDeckTeam | null> => {
      const teamId = parseId(teamIdRaw, 'teamId');
      const team = agentDeckTeamRepo.archive(teamId, { reason: 'user-action' });
      if (team) eventBus.emit('agent-deck-team-updated', team);
      return team;
    },
  );

  // Unarchive
  on(
    IpcInvoke.AgentDeckTeamUnarchive,
    async (_e, teamIdRaw): Promise<AgentDeckTeam | null> => {
      const teamId = parseId(teamIdRaw, 'teamId');
      const team = agentDeckTeamRepo.unarchive(teamId);
      if (team) eventBus.emit('agent-deck-team-updated', team);
      return team;
    },
  );

  // Add member
  on(
    IpcInvoke.AgentDeckTeamAddMember,
    async (_e, input): Promise<AgentDeckTeamMember> => {
      if (!input || typeof input !== 'object') {
        throw new IpcInputError('input', 'input must be { teamId, sessionId, role, displayName? }');
      }
      const obj = input as Record<string, unknown>;
      const teamId = parseId(obj.teamId, 'teamId');
      const sessionId = parseId(obj.sessionId, 'sessionId');
      const role = obj.role;
      if (role !== 'lead' && role !== 'teammate') {
        throw new IpcInputError('role', 'role must be "lead" or "teammate"');
      }
      const displayName =
        typeof obj.displayName === 'string' && obj.displayName.trim()
          ? obj.displayName.trim().slice(0, 128)
          : null;
      // 校验 session 存在
      if (!sessionRepo.get(sessionId)) {
        throw new IpcInputError('sessionId', `session ${sessionId} not found`);
      }
      const member = agentDeckTeamRepo.addMember({
        teamId,
        sessionId,
        role: role as AgentDeckTeamMemberRole,
        displayName,
      });
      eventBus.emit('agent-deck-team-member-changed', {
        teamId,
        sessionId,
        kind: 'joined',
      });
      return member;
    },
  );

  // Remove member（leaveTeam 写 left_at；不删 row）
  on(
    IpcInvoke.AgentDeckTeamRemoveMember,
    async (_e, input): Promise<{ ok: boolean }> => {
      if (!input || typeof input !== 'object') {
        throw new IpcInputError('input', 'input must be { teamId, sessionId }');
      }
      const obj = input as Record<string, unknown>;
      const teamId = parseId(obj.teamId, 'teamId');
      const sessionId = parseId(obj.sessionId, 'sessionId');
      const left = agentDeckTeamRepo.leaveTeam(teamId, sessionId);
      if (left) {
        eventBus.emit('agent-deck-team-member-changed', { teamId, sessionId, kind: 'left' });
        // 0-lead 自动 archive 兜底（与 sessionManager.delete 同语义）
        const remaining = agentDeckTeamRepo.countActiveLeads(teamId);
        if (remaining === 0) {
          const team = agentDeckTeamRepo.archive(teamId, { reason: 'last-lead-deleted' });
          if (team) eventBus.emit('agent-deck-team-updated', team);
        }
      }
      return { ok: !!left };
    },
  );

  // Send cross-adapter message（IPC 入口；MCP 走 enqueueAgentDeckMessage 同函数）
  on(
    IpcInvoke.AgentDeckTeamSendMessage,
    async (_e, input): Promise<AgentDeckMessage> => {
      if (!input || typeof input !== 'object') {
        throw new IpcInputError(
          'input',
          'input must be { teamId, fromSessionId, toSessionId, body }',
        );
      }
      const obj = input as Record<string, unknown>;
      const teamId = parseId(obj.teamId, 'teamId');
      const fromSessionId = parseId(obj.fromSessionId, 'fromSessionId');
      const toSessionId = parseId(obj.toSessionId, 'toSessionId');
      if (typeof obj.body !== 'string' || !obj.body) {
        throw new IpcInputError('body', 'body required (non-empty string)');
      }
      // 校验 from / to 都在该 team active
      const members = agentDeckTeamRepo.listActiveMembers(teamId);
      const memberIds = new Set(members.map((m) => m.sessionId));
      if (!memberIds.has(fromSessionId)) {
        throw new IpcInputError('fromSessionId', `${fromSessionId} not active in team ${teamId}`);
      }
      if (!memberIds.has(toSessionId)) {
        throw new IpcInputError('toSessionId', `${toSessionId} not active in team ${teamId}`);
      }
      const result = enqueueAgentDeckMessage({
        teamId,
        fromSessionId,
        toSessionId,
        body: obj.body,
      });
      if (!result.ok) {
        throw new Error(`${result.error} (retryAfterMs=${result.retryAfterMs})`);
      }
      return result.message;
    },
  );

  // List messages by team
  on(
    IpcInvoke.AgentDeckMessageListByTeam,
    async (_e, input): Promise<AgentDeckMessage[]> => {
      if (!input || typeof input !== 'object') {
        throw new IpcInputError('input', 'input must be { teamId, limit?, offset? }');
      }
      const obj = input as Record<string, unknown>;
      const teamId = parseId(obj.teamId, 'teamId');
      const limit =
        typeof obj.limit === 'number' && obj.limit > 0 ? Math.min(obj.limit, 500) : 100;
      const offset =
        typeof obj.offset === 'number' && obj.offset >= 0 ? obj.offset : 0;
      return agentDeckMessageRepo.listByTeam(teamId, { limit, offset });
    },
  );

  // List messages by session（plan mcp-bug-and-feature-batch-20260513 Phase 5 Step 5.2）
  on(
    IpcInvoke.AgentDeckMessageListBySession,
    async (_e, input): Promise<AgentDeckMessage[]> => {
      if (!input || typeof input !== 'object') {
        throw new IpcInputError('input', 'input must be { sessionId, limit?, offset? }');
      }
      const obj = input as Record<string, unknown>;
      const sessionId = parseId(obj.sessionId, 'sessionId');
      const limit =
        typeof obj.limit === 'number' && obj.limit > 0 ? Math.min(obj.limit, 500) : 100;
      const offset =
        typeof obj.offset === 'number' && obj.offset >= 0 ? obj.offset : 0;
      return agentDeckMessageRepo.listBySession(sessionId, { limit, offset });
    },
  );

  // Cancel message（pending / delivering → cancelled）
  on(
    IpcInvoke.AgentDeckMessageCancel,
    async (_e, input): Promise<AgentDeckMessage | null> => {
      if (!input || typeof input !== 'object') {
        throw new IpcInputError('input', 'input must be { messageId, reason? }');
      }
      const obj = input as Record<string, unknown>;
      const messageId = parseId(obj.messageId, 'messageId');
      const reason =
        typeof obj.reason === 'string' && obj.reason.trim()
          ? obj.reason.trim().slice(0, 500)
          : 'user-cancel';
      const msg = agentDeckMessageRepo.cancel(messageId, reason);
      if (msg) {
        eventBus.emit('agent-deck-message-status-changed', {
          id: msg.id,
          teamId: msg.teamId,
          status: msg.status,
          statusReason: msg.statusReason,
        });
      }
      return msg;
    },
  );

  // TaskListByTeam：用 team_id 查 tasks（v011），R3.E8 配套 task-manager 迁移
  on(
    IpcInvoke.TaskListByTeam,
    async (_e, teamIdRaw): Promise<{ tasks: TaskRecord[] }> => {
      const teamId = parseId(teamIdRaw, 'teamId');
      return { tasks: taskRepo.list({ teamId, limit: 200 }) };
    },
  );

  // plan team-cohesion-fix-20260513 Phase F D7：批量 close team 内仅 teammate role 的 active
  // 成员（lead 不动，避免误关用户主操作 session）。
  // - 使用 sessionManager.close（async）串行 close（避免并发 race + 0-lead archive 时序）
  // - 失败收集到 failed[]，不一刀切失败
  // - close 内部已自动 leaveTeam（D6 helper），不需要这里再 leaveTeam
  on(
    IpcInvoke.AgentDeckTeamShutdownAllTeammates,
    async (_e, teamIdRaw): Promise<{ closed: string[]; failed: { sessionId: string; reason: string }[] }> => {
      const teamId = parseId(teamIdRaw, 'teamId');
      const members = agentDeckTeamRepo.listActiveMembers(teamId);
      const teammates = members.filter((m) => m.role === 'teammate');
      const closed: string[] = [];
      const failed: { sessionId: string; reason: string }[] = [];
      for (const m of teammates) {
        try {
          await sessionManager.close(m.sessionId);
          closed.push(m.sessionId);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          failed.push({ sessionId: m.sessionId, reason });
          console.warn(
            `[ipc:team-shutdown-all-teammates] close(${m.sessionId}) failed in team ${teamId}:`,
            err,
          );
        }
      }
      return { closed, failed };
    },
  );
}
