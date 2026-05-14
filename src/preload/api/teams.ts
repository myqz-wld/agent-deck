/**
 * preload/api/teams: R3.E8 Universal Team Backend IPC facade（替代老 Agent Teams M2/M3 facade）。
 *
 * 包含 team CRUD / 成员管理 / 跨 adapter 消息 / 任务，以及对应的两组实时推送订阅
 * （onAgentDeckTeamChanged / onAgentDeckMessageChanged）。
 */

import { ipcRenderer } from 'electron';
import { IpcEvent, IpcInvoke } from '@shared/ipc-channels';
import type {
  AgentDeckMessage,
  AgentDeckTeam,
  AgentDeckTeamMember,
  AgentDeckTeamMemberRole,
  AgentEvent,
  TaskRecord,
} from '@shared/types';

export const teamsApi = {
  // ─────────── R3.E8 Universal Team Backend (替代老 Agent Teams M2/M3 facade) ───────────
  /** 列出 active team。pass { includeArchived: true } 看含 archived 的全集。 */
  listAgentDeckTeams: (opts?: { includeArchived?: boolean }): Promise<AgentDeckTeam[]> =>
    ipcRenderer.invoke(IpcInvoke.AgentDeckTeamList, opts ?? {}),
  /** 拉一个 team 的完整 snapshot（含 members + 最近 100 条 messages）。 */
  getAgentDeckTeam: (
    teamId: string,
  ): Promise<
    | (AgentDeckTeam & { members: AgentDeckTeamMember[]; recentMessages: AgentDeckMessage[] })
    | null
  > => ipcRenderer.invoke(IpcInvoke.AgentDeckTeamGet, teamId),
  /**
   * plan team-cohesion-fix-20260513 Phase C：拉 team 4 sections snapshot
   * （events 50 条 + tasks + messages 100 条 + members）。lineage / pending 由 renderer 自拼。
   */
  getAgentDeckTeamFull: (
    teamId: string,
  ): Promise<
    | (AgentDeckTeam & {
        members: AgentDeckTeamMember[];
        recentEvents: (AgentEvent & { id: number })[];
        tasks: TaskRecord[];
        recentMessages: AgentDeckMessage[];
      })
    | null
  > => ipcRenderer.invoke(IpcInvoke.AgentDeckTeamGetFull, teamId),
  /** 显式建 team。 */
  createAgentDeckTeam: (input: {
    name: string;
    metadata?: Record<string, unknown>;
  }): Promise<AgentDeckTeam> => ipcRenderer.invoke(IpcInvoke.AgentDeckTeamCreate, input),
  /** 归档 team（标 archived_at；不删数据）。 */
  archiveAgentDeckTeam: (teamId: string): Promise<AgentDeckTeam | null> =>
    ipcRenderer.invoke(IpcInvoke.AgentDeckTeamArchive, teamId),
  /** 取消归档（如有 active 同名 team 抛错）。 */
  unarchiveAgentDeckTeam: (teamId: string): Promise<AgentDeckTeam | null> =>
    ipcRenderer.invoke(IpcInvoke.AgentDeckTeamUnarchive, teamId),
  /**
   * plan team-cohesion-fix-20260513 Phase F D7：批量 close 该 team 内仅 teammate role
   * 的 active 成员（lead 不动）。返回 { closed, failed[] }。close 内部自动 leaveTeam。
   */
  shutdownAllTeammates: (
    teamId: string,
  ): Promise<{ closed: string[]; failed: { sessionId: string; reason: string }[] }> =>
    ipcRenderer.invoke(IpcInvoke.AgentDeckTeamShutdownAllTeammates, teamId),
  /** 加 member。 */
  addAgentDeckTeamMember: (input: {
    teamId: string;
    sessionId: string;
    role: AgentDeckTeamMemberRole;
    displayName?: string;
  }): Promise<AgentDeckTeamMember> =>
    ipcRenderer.invoke(IpcInvoke.AgentDeckTeamAddMember, input),
  /** member 离开 team（写 left_at；不删 row）。 */
  removeAgentDeckTeamMember: (input: {
    teamId: string;
    sessionId: string;
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IpcInvoke.AgentDeckTeamRemoveMember, input),
  /** 显式发 cross-adapter team message。 */
  sendAgentDeckTeamMessage: (input: {
    teamId: string;
    fromSessionId: string;
    toSessionId: string;
    body: string;
  }): Promise<AgentDeckMessage> =>
    ipcRenderer.invoke(IpcInvoke.AgentDeckTeamSendMessage, input),
  /** 拉 team 的近期消息流。 */
  listAgentDeckMessagesByTeam: (input: {
    teamId: string;
    limit?: number;
    offset?: number;
  }): Promise<AgentDeckMessage[]> =>
    ipcRenderer.invoke(IpcInvoke.AgentDeckMessageListByTeam, input),
  /** 拉某 session 涉及的 cross-session messages（plan mcp-bug-and-feature-batch-20260513 Phase 5 Step 5.2）。 */
  listAgentDeckMessagesBySession: (input: {
    sessionId: string;
    limit?: number;
    offset?: number;
  }): Promise<AgentDeckMessage[]> =>
    ipcRenderer.invoke(IpcInvoke.AgentDeckMessageListBySession, input),
  /** Cancel 一条 pending / delivering message。 */
  cancelAgentDeckMessage: (input: {
    messageId: string;
    reason?: string;
  }): Promise<AgentDeckMessage | null> =>
    ipcRenderer.invoke(IpcInvoke.AgentDeckMessageCancel, input),
  /** 拉指定 team 的 SQLite tasks（v011 + R3.E8 task-manager 迁移）。 */
  listTeamTasks: (teamId: string): Promise<{ tasks: TaskRecord[] }> =>
    ipcRenderer.invoke(IpcInvoke.TaskListByTeam, teamId),

  /** 订阅 team 增删改 / member 改的 push（main bootstrap 16ms debounce + per-team 累加）。 */
  onAgentDeckTeamChanged: (
    cb: (
      items: { kind: string; teamId: string; payload: unknown }[],
    ) => void,
  ): (() => void) => {
    const handler = (
      _: unknown,
      items: { kind: string; teamId: string; payload: unknown }[],
    ): void => cb(items);
    ipcRenderer.on(IpcEvent.AgentDeckTeamChanged, handler);
    return () => ipcRenderer.off(IpcEvent.AgentDeckTeamChanged, handler);
  },
  /** 订阅 message 入队 / 状态变迁 push（main bootstrap 16ms debounce + per-message 累加）。 */
  onAgentDeckMessageChanged: (
    cb: (
      items: { kind: string; teamId: string; messageId: string; payload: unknown }[],
    ) => void,
  ): (() => void) => {
    const handler = (
      _: unknown,
      items: { kind: string; teamId: string; messageId: string; payload: unknown }[],
    ): void => cb(items);
    ipcRenderer.on(IpcEvent.AgentDeckMessageChanged, handler);
    return () => ipcRenderer.off(IpcEvent.AgentDeckMessageChanged, handler);
  },
};
