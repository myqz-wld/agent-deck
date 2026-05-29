/**
 * Task handler 共享 runtime helper（v024 plan task-team-id-restore-20260525 重写 — v023 follow-up）。
 *
 * 从原 `src/main/task-manager/tools.ts:71-154` 抽出，让 5 个 task handler 共享避免复制漂移：
 * - `argsToInputWithoutOwner`: camelCase args → camelCase TaskCreateInput 子集（不含 ownerSessionId）
 * - `isCallerAuthorizedToWrite`: 写权限校验（v024 改签名 `(callerSid, task)` 按 task.teamId 判 — D3）
 * - `isCallerAuthorizedToRead`: read 权限校验（v024 新增 MED-1 修法,与 write 对称）
 * - `isCallerInTeam`: caller 是否在指定 team 是 active member（task_create 团 teamId 校验用）
 * - `getVisibleTaskScope`: caller 视角 visible task scope（v024 替代 getVisibleOwnerSessionIds）
 *
 * **删除**: `getCallerFirstTeamName`（v023 为 ingest payload.teamName 提供 first team 名,
 * v024 plan §不变量 6 + Step C2/Step C4 修法 — handler 直接走 agentDeckTeamRepo.get(teamId)?.name
 * 取 args.teamId 或 task.teamId lookup,避免 multi-team caller 漂移到 first team）。
 *
 * **不在本文件**：`STATUS_VALUES` → `src/main/agent-deck-mcp/tools/schemas.ts` 顶部 export
 * （avoid schema 层从 handler 层间接拉 sessionRepo / agentDeckTeamRepo 运行时依赖）。
 */

import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import type { TaskCreateInput } from '@main/store/task-repo';
import type { TaskRecord, TaskStatus } from '@shared/types';

/**
 * 把 zod 解析后的 args（camelCase + nullable | undefined）转成
 * TaskCreateInput 子集（不含 ownerSessionId —— 那是 closure 强制注入）。
 * 仅放入「显式传了的字段」（!== undefined），让 repo 的 update 路径区分「不动」
 * 与「设为 null」。
 */
export function argsToInputWithoutOwner(args: {
  subject?: string;
  description?: string | null;
  status?: TaskStatus;
  activeForm?: string | null;
  priority?: number;
  blocks?: string[];
  blockedBy?: string[];
  labels?: string[];
  teamId?: string | null;
}): Omit<Partial<TaskCreateInput>, 'ownerSessionId'> {
  const out: Omit<Partial<TaskCreateInput>, 'ownerSessionId'> = {};
  if (args.subject !== undefined) out.subject = args.subject;
  if (args.description !== undefined) out.description = args.description;
  if (args.status !== undefined) out.status = args.status;
  if (args.activeForm !== undefined) out.activeForm = args.activeForm;
  if (args.priority !== undefined) out.priority = args.priority;
  if (args.blocks !== undefined) out.blocks = args.blocks;
  if (args.blockedBy !== undefined) out.blockedBy = args.blockedBy;
  if (args.labels !== undefined) out.labels = args.labels;
  // v024 plan §D1+D2:支持 update 改 teamId（传 null 转 personal,传 string 转 team-bound）。
  if (args.teamId !== undefined) out.teamId = args.teamId;
  return out;
}

/**
 * v024 plan §D2 + Step C2:caller 是否在指定 team 是 active member。
 *
 * task_create / task_update 显式传 teamId 时校验用。语义对齐 §不变量 13 active 双条件:
 * - agent_deck_team_members.left_at IS NULL（成员未软退出）
 * - agent_deck_teams.archived_at IS NULL（团队未归档）
 *
 * 复用 agentDeckTeamRepo.findActiveMembershipsBySession（已 SQL JOIN 双条件）。
 */
export function isCallerInTeam(callerSid: string, teamId: string): boolean {
  const memberships = agentDeckTeamRepo.findActiveMembershipsBySession(callerSid);
  for (const m of memberships) {
    if (m.teamId !== teamId) continue;
    // F2 修法 + §不变量 13 双条件:二查 team row 过滤 archived team(member 行 active 但
    // team 已 archived 的 ghost membership)。team row missing 也跳过(DB 不一致 corner case)。
    const team = agentDeckTeamRepo.get(teamId);
    if (team !== null && team.archivedAt === null) return true;
  }
  return false;
}

/**
 * v024 plan §D5 + Step C5:caller 视角 visible task scope（替代 v023 getVisibleOwnerSessionIds）。
 *
 * 返:`{ teamIds: string[], includeOwnPersonal: true }` — task_list query 端用
 *   `(teamId IN teamIds) OR (teamId IS NULL AND owner_session_id == callerSid)`
 * 一次 SQL 拿 caller 可见所有 task（team-bound + own personal）。
 *
 * **§不变量 7 archived team filter 纪律**:仅返 active team teamIds（左 archived team
 * 上的 task 不可见，对齐 send_message active-shared filter + write 路径双条件 active
 * member check — 详 §不变量 13）。
 *
 * 失败兜底:caller 无 active team membership → 返 `{teamIds: [], includeOwnPersonal: true}`
 * （仅 caller 自己 personal task 可见,task_list query 退化为 owner_session_id IN [callerSid]
 * 单 SQL）。
 */
export function getVisibleTaskScope(callerSid: string): {
  teamIds: string[];
  includeOwnPersonal: true;
} {
  const memberships = agentDeckTeamRepo.findActiveMembershipsBySession(callerSid);
  const teamIds: string[] = [];
  for (const m of memberships) {
    const team = agentDeckTeamRepo.get(m.teamId);
    if (team === null || team.archivedAt !== null) continue;
    teamIds.push(m.teamId);
  }
  return { teamIds, includeOwnPersonal: true };
}

/**
 * v024 plan §D3 + Step C5:写权限校验（HIGH-2 改签名传 task 对象拿 teamId）。
 *
 * 分支语义:
 * - **`task.teamId !== null` (team-bound)**:caller 必须在该 team 是 active member（双条件
 *   `agent_deck_team_members.left_at IS NULL AND agent_deck_teams.archived_at IS NULL`,§不变量 13）。
 *   不论 caller 是否是 owner。
 * - **`task.teamId === null` (personal task)**:caller == owner 才能写（不开放同 team 共享 — D3）。
 *
 * **F-R2-C 防御边界沿用**(v023 deep-review):callerSid === ownerSid 特例 personal task 路径
 * 不查 caller archived/lifecycle,但双重锁(in-process closure / external deny)实际无利用面。
 *
 * **传 task 对象**(Round 1 HIGH-2 修法):至少 ownerSessionId + teamId,Pick<TaskRecord> 即可。
 * task-delete cascade predicate 调用方传 child task 对象（不是字符串 ownerSid）— 详 task-repo.ts
 * delete predicate signature `(id, child: Pick<TaskRecord, 'ownerSessionId' | 'teamId'>) => boolean`。
 */
export function isCallerAuthorizedToWrite(
  callerSid: string,
  task: Pick<TaskRecord, 'ownerSessionId' | 'teamId'>,
): boolean {
  if (task.teamId !== null) {
    // team-bound task:caller 必须在该 team 是 active member（不论 owner）
    return isCallerInTeam(callerSid, task.teamId);
  }
  // personal task (teamId === null):caller == owner 才能写
  return callerSid === task.ownerSessionId;
}

/**
 * v024 plan §D3 + Round 1 MED-1 修法 + Step C5/C7:read 权限校验（与 write 对称）。
 *
 * read scope 与 write scope 完全对称（D3 read/write 镜像）:
 * - **`task.teamId !== null`**:caller 必须在该 team 是 active member
 * - **`task.teamId === null` (personal)**:caller == owner 才能读
 *
 * **v023 → v024 推翻**(plan §D8): in-process lead 跨 team 看 teammate task / external mcp
 * client 凭已知 taskId 查 task 两类 use case 都被 v024 推翻。task_get external 已经在
 * EXTERNAL_CALLER_ALLOWED.task_get=false flip 后被 withMcpGuard 入口拦截,本 helper
 * 仅服务 in-process caller 的 team scope 校验。
 */
export function isCallerAuthorizedToRead(
  callerSid: string,
  task: Pick<TaskRecord, 'ownerSessionId' | 'teamId'>,
): boolean {
  // read/write 镜像（D3）:逻辑同 isCallerAuthorizedToWrite
  return isCallerAuthorizedToWrite(callerSid, task);
}
