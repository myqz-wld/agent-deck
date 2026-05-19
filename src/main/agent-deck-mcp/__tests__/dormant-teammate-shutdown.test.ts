/**
 * F1a inline 实证（plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 5.1）。
 *
 * 上轮 R3 实证「6 reviewer dormant 未 closed」误归因到 listActiveMembers 过滤 lifecycle。
 * lead 现场 grep + reviewer 双方独立 cross-cite 验证后真根因 = F2 mainRepo dirty precheck
 * fail-fast 拦下 archive_plan tool → 用户走手工归档绕过 → runBatonCleanup 没被调到 → 6
 * reviewer 自然衰减成 dormant 但**没** closed。
 *
 * F1a 修法是 **confirm 而非新加 SQL 修法**。本文件 inline 实证现状（plan §D4）：
 *
 * 1. **listActiveMembers SQL 不过滤 lifecycle**（agent-deck-team-repo/member-query.ts:47-57）
 *    `WHERE m.team_id = ? AND m.left_at IS NULL AND s.archived_at IS NULL`
 *    没有 `AND s.lifecycle != 'dormant'`，dormant teammate 仍列在候选 — case A 实测验证
 *
 * 2. **shutdownTeammatesOnBaton helper 不区分 lifecycle**（shutdown-teammates-on-baton.ts）
 *    helper 拿到 listActiveMembers 结果直接串行 closeFn(sid)，不读 sessions.lifecycle。
 *    closeFn 默认走 sessionManager.close → setLifecycle(sid, 'closed') + leaveTeamsAndAutoArchive
 *    → team_member.left_at 软退出 — case A assert closed[] 透传契约
 *
 * 3. **archive_plan handler 默认调 runBatonCleanup → 调 helper**（archive-plan.ts:181-191）
 *    `keep_teammates: false` default。end-to-end 集成已在 archive-plan.handler.test.ts
 *    CHANGELOG_106 段 cover（mock shutdownTeammates seam 验证 handler→helper 契约）。
 *    本文件 case A 走真 helper（不 mock seam），inject deeper mock 验证 helper 默认行为。
 *
 * **测试边界**:
 * - 不端到端走真 sessionManager / sessionRepo / agentDeckTeamRepo（撞 DB 未 init 噪音）
 * - 走 deps inject 模式（与 shutdown-teammates-on-baton.test.ts 同款），mock listActiveMembers
 *   等 4 个 deps，让 helper 真跑串行 closeFn 逻辑
 * - dormant 状态本身在 sessions.lifecycle 字段（不在 team_member），AgentDeckTeamMember
 *   interface 不含 lifecycle 字段；本 case 通过 listActiveMembers mock 返回值 + 注释说明
 *   dormant 同款被列入即可 confirm 契约
 */

import { describe, expect, it } from 'vitest';
import type { AgentDeckTeamMember } from '@shared/types';
import { shutdownTeammatesOnBaton } from '../tools/handlers/shutdown-teammates-on-baton';

function makeMember(opts: {
  teamId: string;
  sessionId: string;
  role: 'lead' | 'teammate';
}): AgentDeckTeamMember {
  return {
    teamId: opts.teamId,
    sessionId: opts.sessionId,
    role: opts.role,
    displayName: null,
    joinedAt: 1_000,
    leftAt: null,
  };
}

describe('F1a inline 实证（plan §Phase 5.1）— dormant teammate 不被过滤同款被 close', () => {
  it('case A: lead + 2 dormant teammate → listActiveMembers 不过滤 lifecycle 同款列入 → closeFn 全调 → closed=[B,C]', async () => {
    /**
     * 模拟流程（plan §Phase 5.1 描述）:
     * - lead session A 起 team
     * - teammate B / C 加入 team
     * - lifecycle scheduler tick 后 B/C 转 dormant（应用层语义,sessions.lifecycle='dormant'）
     * - archive_plan handler 调用 → runBatonCleanup → shutdownTeammatesOnBaton helper
     *
     * 关键 invariant 实证（plan §D4 真根因复诊）:
     * - listActiveMembers SQL JOIN sessions 仅 `s.archived_at IS NULL` 过滤,**不**含
     *   `s.lifecycle != 'dormant'` 过滤,dormant teammate 仍列在 mock 返回中
     * - helper 不读 lifecycle 字段,直接串行 closeFn(sid)
     * - closeFn 默认走 sessionManager.close 对任意存在 session（含 dormant）都
     *   setLifecycle('closed') + team_member.left_at 软退出
     */
    const closeCalls: string[] = [];
    const result = await shutdownTeammatesOnBaton('lead-A', {
      findActiveMembershipsBySession: (sid) =>
        sid === 'lead-A'
          ? [makeMember({ teamId: 'team-1', sessionId: 'lead-A', role: 'lead' })]
          : [],
      // 关键: listActiveMembers mock 返回含「dormant lifecycle」的 teammate B/C —
      // SQL 在 schema 层不过滤 lifecycle,所以即使 B/C lifecycle='dormant',仍命中
      // m.left_at IS NULL AND s.archived_at IS NULL 条件,出现在 active member 列表
      listActiveMembers: (teamId) =>
        teamId === 'team-1'
          ? [
              makeMember({ teamId: 'team-1', sessionId: 'lead-A', role: 'lead' }),
              // teammate-dormant-B: sessions.lifecycle='dormant' but team_member.left_at IS NULL
              makeMember({ teamId: 'team-1', sessionId: 'teammate-dormant-B', role: 'teammate' }),
              // teammate-dormant-C: sessions.lifecycle='dormant' but team_member.left_at IS NULL
              makeMember({ teamId: 'team-1', sessionId: 'teammate-dormant-C', role: 'teammate' }),
            ]
          : [],
      closeFn: async (sid) => {
        closeCalls.push(sid);
      },
    });

    // 关键 assert: dormant teammate 全部被 close（不被过滤）
    expect(closeCalls.sort()).toEqual(['teammate-dormant-B', 'teammate-dormant-C']);
    expect(result.closed.sort()).toEqual(['teammate-dormant-B', 'teammate-dormant-C']);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toBeNull();
    // caller 自己不被 close（filter m.sessionId !== callerSessionId）
    expect(closeCalls).not.toContain('lead-A');
  });

  it('case B: lead + 1 active teammate + 1 dormant teammate → 两个 lifecycle 同款被 close（无差异行为）', async () => {
    /**
     * 与 case A 形成对比:即使一个 active 一个 dormant,helper 行为完全相同（不读 lifecycle）。
     * 这是 plan §D4「shutdownTeammatesOnBaton helper 漏 dormant 不成立」的反向兜底实证。
     */
    const closeCalls: string[] = [];
    const result = await shutdownTeammatesOnBaton('lead-A', {
      findActiveMembershipsBySession: () => [
        makeMember({ teamId: 'team-1', sessionId: 'lead-A', role: 'lead' }),
      ],
      listActiveMembers: () => [
        makeMember({ teamId: 'team-1', sessionId: 'lead-A', role: 'lead' }),
        // teammate-active: lifecycle='active'
        makeMember({ teamId: 'team-1', sessionId: 'teammate-active', role: 'teammate' }),
        // teammate-dormant: lifecycle='dormant'
        makeMember({ teamId: 'team-1', sessionId: 'teammate-dormant', role: 'teammate' }),
      ],
      closeFn: async (sid) => {
        closeCalls.push(sid);
      },
    });

    expect(closeCalls.sort()).toEqual(['teammate-active', 'teammate-dormant']);
    expect(result.closed.sort()).toEqual(['teammate-active', 'teammate-dormant']);
    expect(result.failed).toEqual([]);
  });
});
