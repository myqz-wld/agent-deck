/**
 * Task handler 共享 runtime helper（plan task-mcp-merge-into-agent-deck-mcp-20260521 Step 0.5
 * + R1 F12 + R2 F-R2-4 修法）。
 *
 * 从原 `src/main/task-manager/tools.ts:71-154` 抽 4 个 runtime helper（依赖 store/team repo），
 * 让 5 个 task handler 共享避免复制漂移：
 * - `argsToInputWithoutOwner`: snake_case args → camelCase TaskCreateInput 子集（不含 ownerSessionId）
 * - `getVisibleOwnerSessionIds`: caller 视角 visible owner sids（含 F2 archived team filter）
 * - `isCallerAuthorizedToWrite`: 写权限校验（含 caller==owner 特例）
 * - `getCallerFirstTeamName`: ingest payload.teamName 取 caller 当前 first active team name
 *
 * **不在本文件**：`STATUS_VALUES`（R2 F-R2-4 修法 — 避免 schema 层从 handler 层间接拉
 * sessionRepo / agentDeckTeamRepo 运行时依赖，破坏 schemas.ts 纯 zod 边界）→ 放
 * `src/main/agent-deck-mcp/tools/schemas.ts` 顶部 export（schema 层 enum 天然位置），
 * 本文件 + 5 handler 都从 schemas.ts import。
 */

import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import type { TaskCreateInput } from '@main/store/task-repo';
import type { TaskStatus } from '@shared/types';

/**
 * v023：把 zod 解析后的 args（snake_case + nullable | undefined）转成
 * TaskCreateInput 子集（camelCase，不含 ownerSessionId —— 那是 closure 强制注入）。
 * 仅放入「显式传了的字段」（!== undefined），让 repo 的 update 路径区分「不动」
 * 与「设为 null」。
 */
export function argsToInputWithoutOwner(args: {
  subject?: string;
  description?: string | null;
  status?: TaskStatus;
  active_form?: string | null;
  priority?: number;
  blocks?: string[];
  blocked_by?: string[];
  labels?: string[];
}): Omit<Partial<TaskCreateInput>, 'ownerSessionId'> {
  const out: Omit<Partial<TaskCreateInput>, 'ownerSessionId'> = {};
  if (args.subject !== undefined) out.subject = args.subject;
  if (args.description !== undefined) out.description = args.description;
  if (args.status !== undefined) out.status = args.status;
  if (args.active_form !== undefined) out.activeForm = args.active_form;
  if (args.priority !== undefined) out.priority = args.priority;
  if (args.blocks !== undefined) out.blocks = args.blocks;
  if (args.blocked_by !== undefined) out.blockedBy = args.blocked_by;
  if (args.labels !== undefined) out.labels = args.labels;
  return out;
}

/**
 * v023 plan §D6 + deep-review Round 1 F2 修法：算 caller 视角 visible owner session ids。
 *
 * 返回集合 = {callerSid} ∪ {caller 所在每个 **active** team 的所有 active member sids}。
 *
 * **F2 修法**（reviewer-codex MED-1）：findActiveMembershipsBySession 只过滤 `left_at IS NULL`
 * 不过滤 team archived，与 findSharedActiveTeams（write 路径，member-query.ts:141-158 强制
 * `agent_deck_teams.archived_at IS NULL`）边界不一致 — 修前 caller 在 archived team 仍有
 * active membership 时，task_list visible scope 仍含 archived team 所有 session 的 task，
 * 但 task_update / task_delete 走 isCallerAuthorizedToWrite → findSharedActiveTeams 立即拒
 * （archived team 被过滤）→ 「读得到但写不进」UX 矛盾。修法：用 agentDeckTeamRepo.get(teamId)
 * 二查过滤 team archivedAt === null，只保留真正 active team。对 adopt 路径 Phase 7 reviewer-codex
 * Round 2 LOW + Round 3 polish 同款 archived team 过滤纪律对齐。
 *
 * 失败兜底：caller 无 active team membership（全在 archived team / 无 membership）→ 返
 * [callerSid]（仅自己拥有的 task 可见；caller==owner 特例可写）。
 */
export function getVisibleOwnerSessionIds(callerSid: string): string[] {
  const teams = agentDeckTeamRepo.findActiveMembershipsBySession(callerSid);
  const sids = new Set<string>([callerSid]);
  for (const t of teams) {
    // F2 修法：二查 team row，过滤 archived team（member 行 active 但 team 已 archived
    // 的 ghost membership）。team row missing 也跳过（DB 不一致 corner case，FK 应拦）。
    const team = agentDeckTeamRepo.get(t.teamId);
    if (team === null || team.archivedAt !== null) continue;
    for (const m of agentDeckTeamRepo.listActiveMembers(t.teamId)) {
      sids.add(m.sessionId);
    }
  }
  return Array.from(sids);
}

/**
 * v023 plan §D2：写权限校验。caller 必须与 task owner 共享至少 1 个 active team
 * （含 caller == owner 特例 — 自己改自己 task）。跨 team / 无 shared team / 双方
 * archived → reject。
 *
 * 复用 agentDeckTeamRepo.findSharedActiveTeams（单 SQL JOIN，已 archive filter
 * archived team + 双方 archived session）。
 *
 * **F-R2-C 防御边界说明**（deep-review-changelog146-20260524 R2 claude LOW-3）：
 * `callerSid === ownerSid` 特例**不查 caller session archived/lifecycle 状态**，看似 gap
 * 但**双重锁实际无利用面**：
 *   - in-process transport: caller_session_id 由 sdk-bridge closure 强制覆盖为当前 active
 *     SDK session sid（详 types.ts:EXTERNAL_CALLER_SENTINEL jsdoc）；archived session SDK
 *     live query 已被 abort → 不会发 tool call → 不可达
 *   - HTTP / stdio external transport: EXTERNAL_CALLER_ALLOWED.task_update/delete = false
 *     (types.ts) + handler withMcpGuard denyExternalIfNotAllowed 拦截 → 不可达
 * 未来 transport 演化（如 in-process closure 改 lazy 覆盖 / 加 read-only external task
 * write tool）必须同步评估本特例是否仍安全；如安全边界不再成立，应加 `sessions.archived_at
 * IS NULL` 一查或走 single-row team JOIN 验证显式 enforce。
 */
export function isCallerAuthorizedToWrite(callerSid: string, ownerSid: string): boolean {
  if (callerSid === ownerSid) return true;
  return agentDeckTeamRepo.findSharedActiveTeams(callerSid, ownerSid).length > 0;
}

/**
 * 取 caller 第一个 active team name 当 ingest payload.teamName 字段（旧 v007 字段，
 * UI TeamDetail 用来显示「这条 task 在哪个 team」）。新 v023 schema task 不绑
 * team —— team 关系是 caller 视角推出来的，所以 ingest 时取 caller 当前 first
 * active team name 当 nice-to-have 展示信息。caller 无 team → null。
 *
 * 用 batch helper findActiveMembershipsBySessionIds（它 JOIN 了 agent_deck_teams
 * 拿 teamName），单 sid 调 batch overhead 小（IN list 1 个，单 SQL）。
 */
export function getCallerFirstTeamName(callerSid: string): string | null {
  const map = agentDeckTeamRepo.findActiveMembershipsBySessionIds([callerSid]);
  return map.get(callerSid)?.[0]?.teamName ?? null;
}
