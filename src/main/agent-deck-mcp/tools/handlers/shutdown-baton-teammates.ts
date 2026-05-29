/**
 * shutdown_baton_teammates handler 入口（plan deep-review-batch-a1-b-followup-r3-20260519
 * §Phase 5.3 / D4 F1c：escape hatch 让 caller 手工归档后补跑 baton-cleanup phase 1）。
 *
 * 薄 wrapper：withMcpGuard（deny external + validateExternalCaller）+ 调
 * shutdownTeammatesOnBaton helper + 包 ok/err。
 *
 * **场景**：archive_plan tool precheck 失败（mainRepo dirty 撞 archive-critical 路径 / cwd
 * resilience guard 等）→ caller 走 user CLAUDE.md §Step 4 5 步手工归档绕过 archive_plan tool
 * → runBatonCleanup phase 1 没被调到 → 同 team teammate 自然衰减成 dormant 但**没** closed,
 * 占内存 + SDK live query。本 tool 让 caller 显式补跑 phase 1。
 *
 * **行为契约**（plan §F1c + R2 plan-review codex MED-4 错误契约）：
 * - **不**调 phase 2 archive caller（本 tool 设计就是「caller 已经手工归档 / 不归档,仅恢复
 *   baton-cleanup teammate 收口语义」— plan hand-off-session-adopt-teammates-20260520 Phase 3
 *   删 baton-cleanup teammate-shutdown opt-out 字段后,archive_plan / hand_off_session 不再有
 *   phase 1 opt-out,本 escape hatch 是唯一「补跑 phase 1」入口)
 * - findMemberships 返空（caller 不在任何 team 是 lead 或 caller 是 teammate）→ **error + hint**
 *   （非 silent return success）：escape hatch 是 caller 显式请求 cleanup,no-op 误导 caller
 *   以为成功了；改为 error 让 caller 看到「caller 不是任何 team 的 lead,本 tool 无目标可
 *   shutdown」明确指引 IPC TeamShutdownAllTeammates 或 UI Team 面板手动操作。
 *
 * **Deny external caller**（types.ts: EXTERNAL_CALLER_ALLOWED.shutdown_baton_teammates = false）：
 * sessionManager.close 是写操作 + caller=lead 反查需要真实 callerSessionId,绝不允许 stdio
 * external client 调用（避免被恶意 mcp client 利用清理任意 team 内 session）。
 *
 * **mock seam**：handlerDeps.shutdownTeammates 让单测无需 mock 整个 sessionManager / agentDeckTeamRepo,
 * 默认走真 helper（含 sessionManager.close + agentDeckTeamRepo）。
 */

import { err, ok, withMcpGuard, type HandlerContext } from '../helpers';
import type {
  ShutdownBatonTeammatesArgs,
  ShutdownBatonTeammatesResult,
} from '../schemas';
import {
  shutdownTeammatesOnBaton,
  type ShutdownTeammatesResult,
} from './shutdown-teammates-on-baton';

/**
 * 测试 inject seam：test 通过 deps 注入 mock helper 走纯 in-memory。
 * 默认走真 shutdownTeammatesOnBaton helper（内部走真 sessionManager.close / agentDeckTeamRepo）。
 */
export interface ShutdownBatonTeammatesHandlerDeps {
  shutdownTeammates?: (callerSessionId: string) => Promise<ShutdownTeammatesResult>;
}

export const shutdownBatonTeammatesHandler = withMcpGuard(
  'shutdown_baton_teammates',
  async (
    args: ShutdownBatonTeammatesArgs,
    ctx: HandlerContext,
    handlerDeps?: ShutdownBatonTeammatesHandlerDeps,
  ) => {
    const { caller } = ctx;
    const planId = args.planId ?? null;

    const shutdownFn =
      handlerDeps?.shutdownTeammates ??
      ((callerSid: string) => shutdownTeammatesOnBaton(callerSid));

    let result: ShutdownTeammatesResult;
    try {
      result = await shutdownFn(caller.callerSessionId);
    } catch (e) {
      // helper 自身抛错（罕见: agentDeckTeamRepo / sessionManager 异常）→ 透传给 caller
      // 让其看到具体错误（与 archive_plan / hand_off_session runBatonCleanup 兜底 warn
      // 不阻塞行为不同 — 本 tool 是 escape hatch,helper 失败就是「补跑没成功」需让 caller
      // 显式知道,不能假装 ok return）。
      const errStr = e instanceof Error ? e.message : String(e);
      const planSuffix = planId ? ` (planId=${planId})` : '';
      console.warn(
        `[mcp shutdown_baton_teammates] shutdownTeammatesOnBaton helper threw for caller ${caller.callerSessionId}${planSuffix}:`,
        e,
      );
      return err(
        `shutdownTeammatesOnBaton helper failed: ${errStr}`,
        `Internal helper error while resolving caller=${caller.callerSessionId} lead memberships / running close. Common causes: agentDeckTeamRepo DB exception (SQLite locked / read failure) / sessionManager.close abort error. Retry once; if it persists, fall back to UI Team panel "Shutdown all teammates" button or IPC TeamShutdownAllTeammates handler.${planSuffix}`,
      );
    }

    // R2 plan-review codex MED-4 错误契约: caller-not-lead → error + hint（非 silent success）
    if (result.skipped === 'caller-not-lead') {
      return err(
        `caller ${caller.callerSessionId} is not a lead in any active team`,
        `shutdown_baton_teammates only operates on teams where caller is the lead. Caller currently has no `
          + `active membership with role=lead (either caller is a teammate / was never added to any team). `
          + `To clean up dormant teammates of a specific team without requiring caller to be that team's lead, `
          + `use the IPC TeamShutdownAllTeammates handler (with teamId) or the UI Team panel's "Shutdown all teammates" button.`,
      );
    }

    // **REVIEW_56 Batch B R3 reviewer-codex blocker 修法**: 第四态 'all-lead-teams-archived'
    // 必须在 wrapper 转 error (helper 已加新 union 值,但 wrapper 修前只处理 'caller-not-lead'
    // 让其他 skipped 值落到 happy path → ok return.skipped 固定 null 误报成功,违反 escape
    // hatch "no-op 不能误导 caller" 契约)。给"caller 是 lead 但相关 team 已归档"专门 hint —
    // 区别于 'caller-not-lead' 的「caller 完全无 lead 角色」语义。
    if (result.skipped === 'all-lead-teams-archived') {
      return err(
        `caller ${caller.callerSessionId} is lead in some team(s) but all of them are already archived`,
        `shutdown_baton_teammates found caller=lead memberships but all relevant teams have archived_at != null. `
          + `No active lead team → no teammate to clean up via this escape hatch (already-archived teams' members were `
          + `cleaned during team archive cascade). If you need to shut down sessions in an archived team specifically, `
          + `use IPC TeamShutdownAllTeammates handler (with teamId) which doesn't require caller=lead, or shutdown each `
          + `session individually via shutdown_session.`,
      );
    }

    // happy path: closed/failed 透传 + planId 透传
    return ok({
      closed: result.closed,
      failed: result.failed,
      skipped: null,
      planId,
    } satisfies ShutdownBatonTeammatesResult);
  },
);
