/**
 * Agent Deck Universal Team Backend repo facade（R3.E3 / E0 ADR §3）。
 *
 * 持久层：agent_deck_teams + agent_deck_team_members 两表 CRUD。
 * agent_deck_messages 走单独 message-repo（避免单文件过大 + 关注点分离）。
 *
 * 设计要点：
 * - 同步 SQL（与 task-repo / session-repo / event-repo 风格一致）
 * - WAL + 单进程，FK 在 db.ts 内 PRAGMA foreign_keys = ON 已启用
 * - 通过 `createAgentDeckTeamRepo(db)` 工厂注入 db，让测试用 in-memory 数据库独立跑
 * - 默认导出 `agentDeckTeamRepo` 懒拿 getDb()，运行时调用方无感
 *
 * Invariant 强制（ADR §2.1，repo 层而非 SQL trigger）：
 * - active team 必须至少 1 lead（首次 addMember 例外：建 team 后允许短暂无 member 状态）
 * - lead 数量 ≤ 10
 * - 严格在 setRole / removeMember / leaveTeam 时校验，violation 抛 InvariantError
 *
 * 与 sessionManager.delete pre-check 协作（ADR §2.5）：
 * - sessions ON DELETE RESTRICT：直接 DELETE FROM sessions throw FK constraint failed
 * - sessionManager.delete 内调 findActiveMembershipsBySession + 自动 leaveTeam（写
 *   left_at 而非物理删 row，保留历史）+ 触发 0-lead 自动 archive
 *
 * 拆分历史（CHANGELOG_82 / plan deep-review-and-split-20260513 H2 Step 2.2）：
 *   原 src/main/store/agent-deck-team-repo.ts (658 行) 拆为：
 *   - index.ts (本文件，~95 行 facade)
 *   - types.ts (~125 行 errors / row types / row→record / input shapes / MAX_LEADS_PER_TEAM)
 *   - team-crud.ts (~190 行 9 funcs：create/ensureByName/get/getByActiveName/getWithMembers/list/archive/unarchive/hardDelete)
 *   - member-crud.ts (~165 行 3 funcs：addMember/leaveTeam/setRole)
 *   - member-query.ts (~155 行 6 funcs：listActiveMembers / listAllMembers /
 *     findActiveMembershipsBySession / findActiveMembershipsBySessionIds /
 *     findSharedActiveTeams / countActiveLeads)
 *   外部 caller import 路径不变（'@main/store/agent-deck-team-repo' 自动 resolve 到 index.ts）。
 */
import type { Database } from 'better-sqlite3';
import type {
  AgentDeckTeam,
  AgentDeckTeamArchiveReason,
  AgentDeckTeamMember,
  AgentDeckTeamMemberRole,
  SessionTeamMembership,
} from '@shared/types';

import { getDb } from '../db';
import { createTeamCrudHelpers } from './team-crud';
import { createMemberCrudHelpers } from './member-crud';
import { createMemberQueryHelpers } from './member-query';
import type { AddMemberInput, CreateTeamInput, ListTeamsOptions } from './types';

// 错误类与 input/option 类型 re-export，保持外部 caller 能从 facade 一处拿到所有 surface
// （`from '@main/store/agent-deck-team-repo'` 一行覆盖 9 大 export）。
export {
  TeamInvariantError,
  TeamNotFoundError,
  type AddMemberInput,
  type CreateTeamInput,
  type ListTeamsOptions,
} from './types';

export interface AgentDeckTeamRepo {
  // ─── team CRUD ───
  create(input: CreateTeamInput): AgentDeckTeam;
  ensureByName(name: string, metadata?: Record<string, unknown>): AgentDeckTeam;
  get(teamId: string): AgentDeckTeam | null;
  getByActiveName(name: string): AgentDeckTeam | null;
  getWithMembers(teamId: string): (AgentDeckTeam & { members: AgentDeckTeamMember[] }) | null;
  list(opts?: ListTeamsOptions): AgentDeckTeam[];
  archive(teamId: string, opts?: { reason?: AgentDeckTeamArchiveReason }): AgentDeckTeam | null;
  unarchive(teamId: string): AgentDeckTeam | null;
  hardDelete(teamId: string): boolean;

  // ─── member CRUD ───
  addMember(input: AddMemberInput): AgentDeckTeamMember;
  leaveTeam(teamId: string, sessionId: string): AgentDeckTeamMember | null;
  listActiveMembers(teamId: string): AgentDeckTeamMember[];
  listAllMembers(teamId: string): AgentDeckTeamMember[];
  findActiveMembershipsBySession(sessionId: string): AgentDeckTeamMember[];
  findActiveMembershipsBySessionIds(sessionIds: string[]): Map<string, SessionTeamMembership[]>;
  findSharedActiveTeams(sessionAId: string, sessionBId: string): string[];
  countActiveLeads(teamId: string): number;
  setRole(
    teamId: string,
    sessionId: string,
    role: AgentDeckTeamMemberRole,
  ): AgentDeckTeamMember | null;
}

export function createAgentDeckTeamRepo(db: Database): AgentDeckTeamRepo {
  // 拆分顺序保证 dependency DAG：
  // - member-query 无依赖（纯 read SQL）
  // - team-crud 依赖 member-query.listAllMembers（getWithMembers 用）
  // - member-crud 依赖 team-crud.get（addMember 校验 team 存在）+ member-query
  //   countActiveLeads/listActiveMembers（addMember/setRole 的 lead 数 / 「至少 1 lead」校验）
  const memberQuery = createMemberQueryHelpers(db);
  const teamCrud = createTeamCrudHelpers(db, memberQuery);
  const memberCrud = createMemberCrudHelpers(db, teamCrud, memberQuery);

  return {
    ...teamCrud,
    ...memberCrud,
    ...memberQuery,
  };
}

/** 默认 repo：模块加载时 getDb() 还没 init，所以不能 eager 构造；缓存到模块 closure */
let _defaultRepo: AgentDeckTeamRepo | null = null;
function defaultRepo(): AgentDeckTeamRepo {
  if (!_defaultRepo) _defaultRepo = createAgentDeckTeamRepo(getDb());
  return _defaultRepo;
}

export const agentDeckTeamRepo: AgentDeckTeamRepo = {
  create: (input) => defaultRepo().create(input),
  ensureByName: (name, metadata) => defaultRepo().ensureByName(name, metadata),
  get: (teamId) => defaultRepo().get(teamId),
  getByActiveName: (name) => defaultRepo().getByActiveName(name),
  getWithMembers: (teamId) => defaultRepo().getWithMembers(teamId),
  list: (opts) => defaultRepo().list(opts),
  archive: (teamId, opts) => defaultRepo().archive(teamId, opts),
  unarchive: (teamId) => defaultRepo().unarchive(teamId),
  hardDelete: (teamId) => defaultRepo().hardDelete(teamId),
  addMember: (input) => defaultRepo().addMember(input),
  leaveTeam: (teamId, sessionId) => defaultRepo().leaveTeam(teamId, sessionId),
  listActiveMembers: (teamId) => defaultRepo().listActiveMembers(teamId),
  listAllMembers: (teamId) => defaultRepo().listAllMembers(teamId),
  findActiveMembershipsBySession: (sessionId) =>
    defaultRepo().findActiveMembershipsBySession(sessionId),
  findActiveMembershipsBySessionIds: (sessionIds) =>
    defaultRepo().findActiveMembershipsBySessionIds(sessionIds),
  findSharedActiveTeams: (a, b) => defaultRepo().findSharedActiveTeams(a, b),
  countActiveLeads: (teamId) => defaultRepo().countActiveLeads(teamId),
  setRole: (teamId, sessionId, role) => defaultRepo().setRole(teamId, sessionId, role),
};
