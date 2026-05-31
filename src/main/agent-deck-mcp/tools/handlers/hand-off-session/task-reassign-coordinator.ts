/**
 * hand-off-session task-reassign-coordinator 子模块（plan deep-project-review-comprehensive-20260528
 * Step 4.1 拆分产物，从原 hand-off-session.ts 1306 LOC facade 抽出 task ownership 三态分流
 * 逻辑：archiveCaller=false skip / spawn-no-sid skip / 'skip' / 'clear-team' / 'preserve-team'）。
 *
 * 责任：
 * - taskPolicy 三态分流（plan task-team-id-restore-20260525 v024 §Step D2）
 * - archiveCaller=false 优先级（F1 修法 + Round 7 LOW-1 codex 补全 policy 字段）
 * - newSpawnedSid null 兜底（spawn handler ok return 不带 sessionId — type-safe 兜底）
 * - 'skip' 分支（applyHandOffSkipPolicy 单 transaction 4 步原子化 + safeEmit per-id）
 * - 'clear-team' / 'preserve-team' 分支（reassignOwner SQL 分流）
 * - **preserve-team safety 升级**(Round 4 HIGH-1):reassign 之前 snapshot callerOwnedTeamIds,
 *   reassign 成功后用 newSidActiveTeamIds(adoptedTeamIds ∪ findActiveMembershipIn 实测)
 *   比对差集 → policyWarning='preserve-team-unadopted-teams' + unadoptedTeamIds 字段
 *   (CHANGELOG_169 F5：用 repo 查询验证替代信任 spawnData.teamId 字段)
 *
 * **设计**：handler-main 拿 spawn / phase15 完成结果后调本 helper，本 helper 完整封装
 * 三态分流逻辑返回 taskReassignment 字段。失败仅 warn 不阻塞 ok return（task 过继是
 * nice-to-have，baton 本质是 session 接力），全在内部消化。
 */

import { taskRepo, type ReassignOwnerPolicy, type ApplyHandOffSkipResult } from '@main/store/task-repo';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { eventBus } from '@main/event-bus';
import type { HandOffSessionArgs, HandOffSessionResult } from '../../schemas';
import type { HandOffSessionHandlerDeps } from './_deps';
import type { Phase15Detail } from './team-adopt-coordinator';
import log from '@main/utils/logger';

const logger = log.scope('mcp-task-reassign');

/**
 * Task ownership reassignment 三态分流。
 *
 * 时机要求(plan §不变量 4):spawn 新 session 完成 + 新 sid 已落 DB(spawnResult ok
 * return + spawn handler 内部 sessionRepo.insert 已 commit) + adopt 流程 (如有) 完成
 * 后 → archive caller 之前。无 SQL 错误的成功路径上不留窗口;reassignOwner 抛错时
 * baton 仍继续,由 LifecycleScheduler.historyRetentionDays TTL GC 作 best-effort 兜底。
 *
 * **F1 修法**(deep-review Round 1 双方独立 ✅):仅 `args.archiveCaller !== false`
 * 时自动过继。archiveCaller=false 路径(caller 仍 active,典型场景:lead 起多个
 * hand-off 子任务并行做事 / debug 工具想观察新 session)→ 跳过过继,caller 仍是自己
 * task owner 继续拥有写权限(走 isCallerAuthorizedToWrite caller==owner 特例)。
 * 修前所有路径无条件过继,撞「caller 仍 active 但 task ownership 已转给新 sid,
 * caller 与新 sid 无 shared team(default 不加 team)→ caller 失去自己 task 写权限」
 * 路径 ①(deep-review Round 1 reviewer-claude MED-c1 + reviewer-codex MED-2)。
 *
 * **F3 修法**(reviewer-codex MED-3 + reviewer-claude MED-c5):收集 reassign 状态
 * 进 ok return.taskReassignment 字段(三态枚举 + count + error),caller 可见性强
 * 化。失败仍仅 warn 不阻塞 ok return — task 过继是 nice-to-have,baton 本质是 session
 * 接力,但 caller 通过 ok return 字段看到失败原因,不像修前 console.warn 静默吞错。
 *
 * **v024 plan §Step D2 + R6 MED-2 + R7 LOW-2 修法**:`taskPolicy` const 在 reassign 段
 * 顶部声明(在 args.archiveCaller / args.teamTaskPolicy 三分支判断之前),让 5 个
 * assignment 路径(skip ok / skip failed / clear-team / preserve-team / archiveCaller=false /
 * spawn-no-sid)共用同一外层 scope,所有路径都带 `policy: taskPolicy` field 满足
 * schemas.ts HandOffSessionResult.taskReassignment shape 契约。
 *
 * **v024 plan §Step D2 三态分流**:
 * - `taskPolicy === 'skip'`: 走 applyHandOffSkipPolicy 单 transaction 4 步原子化(SELECT 团 task
 *   → DELETE → cleanup → reassign personal),handler commit 后 per-id safeEmit task-changed
 *   deleted events(inner try/catch + console.warn + continue,沿用 hand-off-session.ts:754-763
 *   现有 pattern);DB throw → outer catch → status='failed' + error,不抛错给 caller
 *   (spawn/adopt 已 commit 不回滚 — v023 §不变量 12 同款 sane fallback)
 * - `taskPolicy === 'clear-team'` (default): reassignOwner({policy:'clear-team'}) UPDATE owner +
 *   teamId=NULL(过继 ownership 同时清 teamId 变 personal,保最大兼容性)
 * - `taskPolicy === 'preserve-team'`: reassignOwner({policy:'preserve-team'}) UPDATE owner 不动
 *   teamId;**preserve-team safety 升级**(Round 4 HIGH-1):reassign 后 query caller owned
 *   distinct teamId(taskRepo.findOwnedDistinctTeamIds)与 newSidActiveTeamIds(phase15Detail.
 *   adoptedTeamIds ∪ findActiveMembershipIn 实测)比对差集 → policyWarning='preserve-team-unadopted-teams'
 *   + unadoptedTeamIds 字段(handler 不 hard reject,soft warning 让 caller 知情决定 retry / 接受降级)
 *
 * **archiveCaller=false 优先级**(F1 修法 + Round 7 LOW-1 codex 补全 policy 字段):caller 显式
 * archiveCaller=false 时**先于 reassign skip 整个过继逻辑**,policy 字段仍透传 advisory(caller
 * 知道传了什么但实际未执行)— `taskReassignment={status:'skipped', reason:'archive-caller-false',
 * policy: taskPolicy}`。
 *
 * newSpawnedSid 为 null(spawn handler ok return 不带 sessionId — 不应发生但 type-safe
 * 兜底)→ taskReassignment.status='skipped' + reason='spawn-no-sid' + policy advisory 透传。
 */
export function runTaskReassignment(
  args: HandOffSessionArgs,
  callerSessionId: string,
  newSpawnedSid: string | null,
  phase15Detail: Phase15Detail,
  handlerDeps: HandOffSessionHandlerDeps | undefined,
): HandOffSessionResult['taskReassignment'] {
  const taskPolicy: 'clear-team' | 'preserve-team' | 'skip' =
    args.teamTaskPolicy ?? 'clear-team';

  if (!newSpawnedSid) {
    logger.warn(
      `[mcp hand_off_session] newSpawnedSid is null after spawn ok return — task ownership reassignment skipped (unexpected: spawn handler should always return sessionId on ok)`,
    );
    return { status: 'skipped', reason: 'spawn-no-sid', policy: taskPolicy };
  }

  if (args.archiveCaller === false) {
    // F1 修法 + Round 7 LOW-1 修法:archiveCaller=false 路径跳过过继,caller 仍 own 自己 task。
    // policy advisory 透传(caller 知道传了什么但实际未执行 policy)。
    return {
      status: 'skipped',
      reason: 'archive-caller-false',
      policy: taskPolicy,
    };
  }

  if (taskPolicy === 'skip') {
    return runSkipPolicy(callerSessionId, newSpawnedSid, taskPolicy, handlerDeps);
  }

  // 'clear-team' (default) | 'preserve-team' 分支
  return runReassignOwnerPolicy(
    callerSessionId,
    newSpawnedSid,
    taskPolicy,
    phase15Detail,
    handlerDeps,
  );
}

/**
 * 'skip' 分支 — 走 applyHandOffSkipPolicy 单 transaction 4 步原子化(plan §Step B1 + D2):
 * SELECT 团 task ids → chunked DELETE → blocks/blockedBy cleanup → reassign personal。
 *
 * **嵌套层级语义**(Round 5 MED-4 显式锁住):
 * - safeEmit loop 嵌入 outer try 内(commit 后 result 可用),catch 分支自然跳过 emit(result 不存在)
 * - safeEmit listener throw 走 inner continue 不冒泡 outer catch — emit 失败不影响 taskReassignment=ok
 * - DB throw 时 outer catch 设置 status='failed' + error 字段,deletedTeamTaskIds 已 throw 不存在
 *   emit 自然跳过(safeEmit loop 在 try 内,catch 不执行 emit)
 * - **不抛错给 caller**(spawn/adopt 已 commit 不可逆 — v023 §不变量 12 同款);ok return 走
 *   status='failed' + error 让 caller 知道 fallback
 * - **policy field required**(Round 6 MED-2):无论 ok / failed 哪条 assignment 路径,
 *   `policy: taskPolicy` 都必带,与 schemas.ts shape 契约对齐
 */
function runSkipPolicy(
  callerSessionId: string,
  newSpawnedSid: string,
  taskPolicy: 'skip',
  handlerDeps: HandOffSessionHandlerDeps | undefined,
): HandOffSessionResult['taskReassignment'] {
  const applySkipFn =
    handlerDeps?.applyHandOffSkipPolicy ??
    ((cs: string, ns: string): ApplyHandOffSkipResult =>
      taskRepo.applyHandOffSkipPolicy(cs, ns));
  try {
    const result = applySkipFn(callerSessionId, newSpawnedSid);
    // safeEmit per-id(plan §Step D2 R4 MED-3:沿用 hand-off-session.ts:754-763 现有 safeEmit
    // pattern — inner try/catch + console.warn + continue,listener throw 不冒泡 outer)
    for (const id of result.deletedTeamTaskIds) {
      try {
        eventBus.emit('task-changed', {
          kind: 'deleted',
          taskId: id,
          task: null,
          ownerSessionId: callerSessionId,
          ts: Date.now(),
        });
      } catch (e) {
        logger.warn(
          `[mcp hand_off_session] teamTaskPolicy='skip' emit task-changed deleted ${id} failed (continuing):`,
          e,
        );
      }
    }
    if (result.deletedTeamTaskIds.length > 0 || result.reassignedPersonalCount > 0) {
      logger.info(
        `[mcp hand_off_session] teamTaskPolicy='skip': ${result.deletedTeamTaskIds.length} team task(s) deleted + ${result.reassignedPersonalCount} personal task(s) reassigned to ${newSpawnedSid}`,
      );
    }
    return {
      status: 'ok',
      count: result.deletedTeamTaskIds.length + result.reassignedPersonalCount,
      policy: taskPolicy,
    };
  } catch (e) {
    // Round 4 MED-2 DB throw fallback — applyHandOffSkipPolicy throw → catch → status='failed'
    // 不抛错给 caller(spawn/adopt 已 commit 不回滚 — v023 §不变量 12 同款 sane fallback)
    logger.warn(
      `[mcp hand_off_session] applyHandOffSkipPolicy threw (continuing — spawn/adopt 已成功不回滚):`,
      e,
    );
    return {
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
      policy: taskPolicy,
    };
  }
}

/**
 * 'clear-team' (default) | 'preserve-team' 分支:走 reassignOwner 接口
 * (UPDATE owner ± teamId=NULL,policy 由 repo 层 SQL 分流)。
 *
 * **preserve-team safety 算法**(Round 4 HIGH-1 + Round 4 MED-1 + Round 5 LOW-2):
 * 1. **reassign 之前** snapshot callerOwnedTeamIds(reassign 之后 owner 已被改成 newSid,
 *    再用 callerSid 反查必为空 — 必须在 reassign 之前 snapshot)
 * 2. 算 newSidActiveTeamIds = phase15Detail.adoptedTeamIds ∪ findActiveMembershipIn 实测
 *    (前者 swapLead 接管 caller-as-lead teams;后者 spawn addMember 失败时不算 active member)
 * 3. 差集 callerOwnedTeamIds \ newSidActiveTeamIds → 非空 → policyWarning='preserve-team-unadopted-teams'
 *    + unadoptedTeamIds 字段(handler 不 hard reject,soft warning 让 caller 知情决定 retry / 接受降级)
 *
 * **CHANGELOG_169 F5 修法**(reviewer-codex MED finding):用 repo 查询验证 newSpawnedSid
 * 对每个 callerOwnedTeamId 是否真 active member,替代信任 spawnData.teamId 字段。spawn
 * handler addMember 失败时(罕见 TeamInvariantError / DB 异常)只 console.warn 不置 null
 * teamId,导致 spawnData.teamId 仍非 null 但 newSid 实际不是 active member → 老 impl 会
 * 把这种「ghost 字段」当作已入队事实压掉 warning,task 已转给 newSid 但写权限 reject。
 */
function runReassignOwnerPolicy(
  callerSessionId: string,
  newSpawnedSid: string,
  taskPolicy: 'clear-team' | 'preserve-team',
  phase15Detail: Phase15Detail,
  handlerDeps: HandOffSessionHandlerDeps | undefined,
): HandOffSessionResult['taskReassignment'] {
  const reassignFn =
    handlerDeps?.reassignTaskOwner ??
    ((oldSid: string, newSid: string, opts: { policy: ReassignOwnerPolicy }) =>
      taskRepo.reassignOwner(oldSid, newSid, opts));

  // **reassign 之前** snapshot callerOwnedTeamIds(仅 preserve-team 路径用,clear-team 路径
  // 不需要 — clear-team 把 teamId 清成 NULL,所有 caller team task 都变 personal,policyWarning
  // 无意义)。
  let callerOwnedTeamIdsBeforeReassign: string[] = [];
  if (taskPolicy === 'preserve-team') {
    const findOwnedFn =
      handlerDeps?.findCallerOwnedTeamIds ??
      ((cs: string) => taskRepo.findOwnedDistinctTeamIds(cs));
    try {
      callerOwnedTeamIdsBeforeReassign = findOwnedFn(callerSessionId);
    } catch (e) {
      // safety query 失败仅 warn 不阻塞 reassign(policyWarning 退化为不触发,
      // sane fallback — caller 仍能通过 reassignedCount 看到主结果)
      logger.warn(
        `[mcp hand_off_session] preserve-team safety query findOwnedDistinctTeamIds failed (continuing — policyWarning will not trigger):`,
        e,
      );
    }
  }

  try {
    const reassignedCount = reassignFn(callerSessionId, newSpawnedSid, {
      policy: taskPolicy,
    });
    if (reassignedCount > 0) {
      logger.info(
        `[mcp hand_off_session] teamTaskPolicy='${taskPolicy}': ${reassignedCount} task(s) reassigned to ${newSpawnedSid}`,
      );
    }

    // **preserve-team safety 比对差集**(reassign 成功后,用之前 snapshot 的 callerOwnedTeamIds
    // 与 newSidActiveTeamIds 算差集)。
    let policyWarning: 'preserve-team-unadopted-teams' | undefined;
    let unadoptedTeamIds: string[] | undefined;
    if (taskPolicy === 'preserve-team' && callerOwnedTeamIdsBeforeReassign.length > 0) {
      // newSidActiveTeamIds 双源:
      // - phase15Detail.adoptedTeamIds: swapLead 成功接管 caller-as-lead teams（Round 4 HIGH-1
      //   集中 push 自 processSwappedTeam helper,L727 + firstTeam/rest loop 全覆盖)
      // - **CHANGELOG_169 F5**: 不再信任 spawnData.teamId;改用 findActiveMembershipIn 实测
      //   newSpawnedSid 对每个 caller-owned team 的真 active membership(spawn addMember 失败
      //   不算 active member,自然不进 set)
      const newSidActiveTeamIds = new Set<string>(phase15Detail.adoptedTeamIds);
      for (const teamId of callerOwnedTeamIdsBeforeReassign) {
        if (newSidActiveTeamIds.has(teamId)) continue;
        try {
          const membership = agentDeckTeamRepo.findActiveMembershipIn(
            teamId,
            newSpawnedSid,
          );
          if (membership !== null) {
            newSidActiveTeamIds.add(teamId);
          }
        } catch (e) {
          // DB 异常 fail-safe:不加进 active set 让差集把该 teamId push 进 unadopted warning
          logger.warn(
            `[mcp hand_off_session] preserve-team safety: findActiveMembershipIn(${teamId}, ${newSpawnedSid}) threw — treating as not-active-member`,
            e,
          );
        }
      }
      const diff = callerOwnedTeamIdsBeforeReassign.filter(
        (t) => !newSidActiveTeamIds.has(t),
      );
      if (diff.length > 0) {
        policyWarning = 'preserve-team-unadopted-teams';
        unadoptedTeamIds = diff;
        logger.warn(
          `[mcp hand_off_session] preserve-team policyWarning='preserve-team-unadopted-teams': caller owned tasks bound to teams [${diff.join(', ')}] but newSid ${newSpawnedSid} 不是这些 team 的 active member → newSid 撞 D3 写权限 reject(caller 自负责任 — adoptTeammates: true 让 newSid 接管 team 当 lead,或接受降级让 task 处于 unreachable 状态)`,
        );
      }
    }

    return {
      status: 'ok',
      count: reassignedCount,
      policy: taskPolicy,
      ...(policyWarning ? { policyWarning } : {}),
      ...(unadoptedTeamIds ? { unadoptedTeamIds } : {}),
    };
  } catch (e) {
    logger.warn(
      `[mcp hand_off_session] task ownership reassign (policy='${taskPolicy}') failed (continuing — task reassignment is nice-to-have, handOff baton still ok; LifecycleScheduler TTL GC will best-effort cleanup):`,
      e,
    );
    return {
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
      policy: taskPolicy,
    };
  }
}
