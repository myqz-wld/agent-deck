/**
 * shutdown-teammates-on-baton —— hand_off_session / archive_plan 共享 helper（CHANGELOG_106）。
 *
 * 场景：caller 是某 team 的 lead，调 hand_off_session（baton 单向交接）或 archive_plan
 * （plan 完成）后 archive 自己。如果不一起处理 team 里的其他 active member（典型：
 * reviewer-claude / reviewer-codex 两个 teammate），它们就成孤儿——team 里没 lead 了，
 * teammate 还在跑（占内存 + SDK live query），用户得手动一个个 shutdown_session。
 *
 * 本 helper 把「caller 是 lead 的所有 team 内其他 active member」一并 sessionManager.close
 * 收口。caller 是 teammate 时 baton 不牵连他人（罕见 case：teammate 自己 hand_off）。
 *
 * **复用现有**：sessionManager.close 内部已自动跑 leaveTeamsAndAutoArchive（让 sid 离开
 * 所有 team + 0-lead team 联动 archive）+ adapter close（abort SDK live query）+ setLifecycle
 * （'closed'）。本 helper 只负责筛选目标 + 串行调度 + 收集结果，**不**重复实现 leave/archive。
 *
 * **mock seam**：所有副作用 fn（findActiveMembershipsBySession / listActiveMembers / closeFn）
 * 通过 deps inject，让单测无需 mock 整个 agentDeckTeamRepo / sessionManager。
 *
 * **失败容错**：
 *   - 单个 close 抛错 → 收 failed[] + console.warn 继续后面 teammate（不一刀切）
 *   - helper 自身反查 / mock 抛错 → 由 caller 端 try/catch 包成 console.warn，本 helper 不另行兜底
 *
 * **plan hand-off-session-adopt-teammates-20260520 Phase 3 简化** (D2 + N4):
 * 删除 baton-cleanup teammate-shutdown opt-out 字段。本 helper 永远跑(caller 不再有
 * 短路途径)。Phase 4 引入 hand_off_session adopt_teammates: true 时走独立 phase 1.5
 * adopt 路径,baton-cleanup helper 用 adoptTeammates: true 跳过本 helper 标
 * skipped='adopt-keep-implicit'(详 baton-cleanup.ts jsdoc)。
 */

import type { AgentDeckTeamMember } from '@shared/types';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { sessionManager } from '@main/session/manager';
import { EXTERNAL_CALLER_SENTINEL } from '../../types';

export interface ShutdownTeammatesResult {
  /** 成功 close 的 teammate sessionId（已 dedup 跨 team 共享同 sid 的情况） */
  closed: string[];
  /** close 失败的 teammate（含 reason，方便用户排查） */
  failed: Array<{ sessionId: string; reason: string }>;
  /**
   * - 'caller-not-lead': caller 在所有 team 都不是 lead（含 external sentinel / 无 membership）
   * - 'adopt-keep-implicit': plan hand-off-session-adopt-teammates-20260520 Phase 4 引入,
   *   hand_off_session adopt_teammates: true 时 baton-cleanup helper 跳过本 helper(由
   *   handler 层 baton-cleanup 入参 adoptTeammates: true 标定)— Phase 3 完成时仅类型预留
   *   不会出现
   * - null: helper 正常处理完（含「caller 是 lead 但 team 内无其他 active teammate」的 closed=[] case）
   */
  skipped: 'caller-not-lead' | 'adopt-keep-implicit' | null;
}

export interface ShutdownTeammatesDeps {
  /** test seam：默认走真 sessionManager.close */
  closeFn?: (sessionId: string) => Promise<void>;
  /** test seam：默认走真 agentDeckTeamRepo */
  findActiveMembershipsBySession?: (sid: string) => AgentDeckTeamMember[];
  listActiveMembers?: (teamId: string) => AgentDeckTeamMember[];
  /**
   * REVIEW_36 R2 HIGH-A：caller 端可显式排除某些 sessionId 不被 shutdown。
   * 典型场景：hand_off_session(team_name=x) 显式 spawn 新 session 后立即调本 helper —
   * 新 session 已被 spawn handler 加为 teammate（spawn.ts:310-317），如果不排除 → helper
   * 把刚交出 baton 的新 session 也关掉（fix-to-fix bug）。
   *
   * caller 已知不该被关的 sid 集合（如 hand-off 新 spawn 的 sessionId）传入此参数即可豁免。
   * 默认空 Set 时行为与原来完全一致（仅排除 callerSessionId）。
   */
  excludeSessionIds?: ReadonlySet<string>;
}

export async function shutdownTeammatesOnBaton(
  callerSessionId: string,
  deps?: ShutdownTeammatesDeps,
): Promise<ShutdownTeammatesResult> {
  // external sentinel: deny external caller 已在 handler 层拦截，理论不会到这；防御性早 return。
  if (callerSessionId === EXTERNAL_CALLER_SENTINEL) {
    return { closed: [], failed: [], skipped: 'caller-not-lead' };
  }

  const findMemberships =
    deps?.findActiveMembershipsBySession ??
    ((sid: string) => agentDeckTeamRepo.findActiveMembershipsBySession(sid));
  const listMembers =
    deps?.listActiveMembers ?? ((teamId: string) => agentDeckTeamRepo.listActiveMembers(teamId));
  const closeFn = deps?.closeFn ?? ((sid: string) => sessionManager.close(sid));
  const excludeSet = deps?.excludeSessionIds ?? new Set<string>();

  // 反查 caller 在哪些 team 里是 lead
  const memberships = findMemberships(callerSessionId);
  const leadTeamIds = memberships.filter((m) => m.role === 'lead').map((m) => m.teamId);

  if (leadTeamIds.length === 0) {
    // caller 在任何 team 都不是 lead（典型：caller 是 teammate / 无 team 关系）→ 不牵连
    return { closed: [], failed: [], skipped: 'caller-not-lead' };
  }

  // 收集所有 caller=lead 的 team 内其他 active teammate（多 team 共享同 sid 时 dedup）
  // REVIEW_36 R2 HIGH-A：排除 callerSessionId + caller 显式 exclude（hand-off 新 spawn 的 sid）
  const targetSids = new Set<string>();
  for (const teamId of leadTeamIds) {
    const members = listMembers(teamId);
    for (const m of members) {
      if (m.sessionId === callerSessionId) continue;
      if (excludeSet.has(m.sessionId)) continue;
      targetSids.add(m.sessionId);
    }
  }

  const closed: string[] = [];
  const failed: Array<{ sessionId: string; reason: string }> = [];

  // 串行 close（避免并发 race + 0-lead team auto-archive 时序，与 IPC TeamShutdownAllTeammates
  // 同款模式 src/main/ipc/teams.ts:340-363）
  for (const sid of targetSids) {
    try {
      await closeFn(sid);
      closed.push(sid);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ sessionId: sid, reason });
      console.warn(`[shutdown-teammates-on-baton] close(${sid}) failed:`, err);
    }
  }

  return { closed, failed, skipped: null };
}
