/**
 * task_list handler — 列 caller 视角 visible task（v024 plan task-team-id-restore-20260525 §D5 三态分流）.
 *
 * v024 plan §D5 三态分流（Step C3）:
 * - **不传 teamIdFilter**:走 visibleScope OR 模式 — caller-owned personal ∪ caller 所在
 *   active team 的 team task 一次 SQL 完成
 * - **传具体 teamId**:走 teamIdFilter=teamId（先校验 caller 在该 team 是 active member,
 *   否则 reject）
 * - **传字面量 'null-personal'**:走 teamIdFilter='null-personal' + ownerSessionIds=[callerSid],
 *   仅返 caller 自己 personal task（owner == caller AND teamId IS NULL）
 *
 * **D6**: EXTERNAL_CALLER_ALLOWED.task_list = true（只读允许 external,external caller 走
 * visibleScope 路径 → callerSid='__external__' 不在任何 team → teamIds=[] + OR 退化仅
 * personal task,owner_session_id != '__external__' → 返空,符合 v023 「返空 visible scope
 * 是预期」语义）。
 *
 * **F2 修法沿用**:getVisibleTaskScope 过滤 archived team（archived team 的 ghost membership
 * 不进 visible scope），与 §不变量 7 + 13 双条件 active-member check 对齐。
 *
 * **F4 修法沿用**:返 { total, hasMore, tasks },hasMore = tasks.length === effectiveLimit。
 */

import { taskRepo } from '@main/store/task-repo';

import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { TaskListArgs, TaskListResult } from '../schemas';
import { getVisibleTaskScope, isCallerInTeam } from './task-helpers';

export const taskListHandler = withMcpGuard(
  'task_list',
  async (args: TaskListArgs, ctx: HandlerContext) => {
    try {
      const callerSid = ctx.caller.callerSessionId;
      const effectiveLimit = args.limit ?? 100;

      // v024 plan §D5 + Step C3:三态分流
      let tasks;
      if (args.teamIdFilter === undefined) {
        // 不传 → caller 可见 scope OR 模式（caller-owned personal ∪ caller 所在 active team
        // 的 team task）。getVisibleTaskScope 已过滤 archived team（§F2 沿用）。
        const scope = getVisibleTaskScope(callerSid);
        tasks = taskRepo.list({
          status: args.statusFilter,
          subjectKeyword: args.subjectFilter,
          visibleScope: { teamIds: scope.teamIds, callerSid },
          limit: effectiveLimit,
          offset: args.offset,
        });
      } else if (args.teamIdFilter === 'null-personal') {
        // 仅 caller 自己 personal task（owner == caller AND teamId IS NULL）
        tasks = taskRepo.list({
          status: args.statusFilter,
          subjectKeyword: args.subjectFilter,
          ownerSessionIds: [callerSid],
          teamIdFilter: 'null-personal',
          limit: effectiveLimit,
          offset: args.offset,
        });
      } else {
        // 具体 teamId:校验 caller 在该 team active member（D5 + §不变量 13 双条件）
        if (!isCallerInTeam(callerSid, args.teamIdFilter)) {
          return err(
            `caller "${callerSid}" is not an active member of teamId "${args.teamIdFilter}" — task_list rejected (v024 plan §D5)`,
            'teamIdFilter 要求 caller 在该 team 是 active member（agent_deck_team_members.left_at IS NULL AND agent_deck_teams.archived_at IS NULL 双条件）。Use task_list without teamIdFilter for caller visible scope, or join the team first via the application UI.',
          );
        }
        tasks = taskRepo.list({
          status: args.statusFilter,
          subjectKeyword: args.subjectFilter,
          teamIdFilter: args.teamIdFilter,
          limit: effectiveLimit,
          offset: args.offset,
        });
      }

      // F4 修法沿用:total 仅是当前页 task 数 + hasMore hint
      return ok({
        total: tasks.length,
        hasMore: tasks.length === effectiveLimit,
        tasks,
      } satisfies TaskListResult);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);
