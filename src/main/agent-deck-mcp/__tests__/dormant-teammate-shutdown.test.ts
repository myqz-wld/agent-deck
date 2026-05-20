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
 *    plan hand-off-session-adopt-teammates-20260520 Phase 3 删 baton-cleanup phase 1 opt-out
 *    字段后,runBatonCleanup 永远调 helper(无 opt-out 路径短路)。end-to-end 集成已在
 *    archive-plan.handler.test.ts CHANGELOG_106 段 cover(mock shutdownTeammates seam 验证
 *    handler→helper 契约)。本文件 case A 走真 helper(不 mock seam),inject deeper mock
 *    验证 helper 默认行为。
 *
 * **测试边界**:
 * - 不端到端走真 sessionManager / sessionRepo / agentDeckTeamRepo（撞 DB 未 init 噪音）
 * - 走 deps inject 模式（与 shutdown-teammates-on-baton.test.ts 同款），mock listActiveMembers
 *   等 4 个 deps，让 helper 真跑串行 closeFn 逻辑
 * - dormant 状态本身在 sessions.lifecycle 字段（不在 team_member），AgentDeckTeamMember
 *   interface 不含 lifecycle 字段；本 case 通过 listActiveMembers mock 返回值 + 注释说明
 *   dormant 同款被列入即可 confirm 契约
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

// ============================================================================
// R3 fix-6 (M6 codex Batch C+D MED-2): 真 SQL invariant 锁(in-memory DB)
//
// 旧 case A/B 用 mock listActiveMembers 手工返回含 dormant 的 member 列表,锁的是 helper
// 不读 lifecycle 字段的契约。但若将来某 PR 改 SQL 加 `s.lifecycle != 'dormant'` 过滤,
// mock test 不会 fail(production 行为变了但 test 没绑 SQL)。本 case 用 in-memory DB 真
// insert dormant lifecycle session + active membership,跑真 createAgentDeckTeamRepo +
// listActiveMembers,锁 SQL invariant: 即使 lifecycle='dormant',`m.left_at IS NULL AND
// s.archived_at IS NULL` 仍命中。SQL 加 lifecycle 过滤 → 本 case 同步 fail 报警。
// ============================================================================

import Database from 'better-sqlite3';
import { createAgentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import {
  bindingAvailable,
  makeMemoryDb,
  insertSession,
} from '@main/store/__tests__/agent-deck-repos/_setup';

/** 插入指定 lifecycle 的 session 行（默认 lifecycle='active'）。 */
function insertSessionWithLifecycle(
  db: Database.Database,
  id: string,
  lifecycle: 'active' | 'dormant' | 'closed' = 'active',
): void {
  db.prepare(
    `INSERT INTO sessions
     (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES (?, 'claude-code', '/tmp', ?, 'sdk', ?, 'idle', 1000, 1000)`,
  ).run(id, `title-${id}`, lifecycle);
}

describe.skipIf(!bindingAvailable)(
  'R3 fix-6 (M6 codex Batch C+D MED-2): listActiveMembers SQL 真 invariant 锁(in-memory DB)',
  () => {
    let db: Database.Database;
    let repo: ReturnType<typeof createAgentDeckTeamRepo>;
    beforeEach(() => {
      db = makeMemoryDb();
      repo = createAgentDeckTeamRepo(db);
    });
    afterEach(() => db.close());

    it('真 SQL: insert lifecycle=dormant session + active membership → listActiveMembers 仍返回(锁 SQL 不过滤 lifecycle invariant)', () => {
      // 起 lead (active lifecycle) + 2 个 teammate (一 active, 一 dormant)
      insertSession(db, 'lead-A');
      insertSessionWithLifecycle(db, 'teammate-active-X', 'active');
      insertSessionWithLifecycle(db, 'teammate-dormant-Y', 'dormant');

      const team = repo.create({ name: 'baton-cleanup-team' });
      repo.addMember({ teamId: team.id, sessionId: 'lead-A', role: 'lead' });
      repo.addMember({
        teamId: team.id,
        sessionId: 'teammate-active-X',
        role: 'teammate',
      });
      repo.addMember({
        teamId: team.id,
        sessionId: 'teammate-dormant-Y',
        role: 'teammate',
      });

      // 锁 invariant: 即使 lifecycle='dormant',只要 m.left_at IS NULL + s.archived_at IS NULL
      // listActiveMembers 仍返回 dormant teammate
      const active = repo.listActiveMembers(team.id);
      const sids = active.map((m) => m.sessionId).sort();
      expect(sids).toEqual(['lead-A', 'teammate-active-X', 'teammate-dormant-Y']);

      // dormant teammate 在结果中 + role='teammate'
      const dormantMember = active.find((m) => m.sessionId === 'teammate-dormant-Y');
      expect(dormantMember).toBeDefined();
      expect(dormantMember!.role).toBe('teammate');
      expect(dormantMember!.leftAt).toBeNull(); // 软退出 leftAt 仍 null（dormant ≠ left）

      // **invariant 校准 (将来若 SQL 加 `s.lifecycle != 'dormant'` 过滤本 case 同步 fail 报警)**:
      // 真 SQL 行为绑定 helper 默认契约(helper 拿到 listActiveMembers 结果直接串行 closeFn),
      // dormant teammate 在 baton-cleanup 路径同款被 close。无回归保护静默 ship。
    });

    it('真 SQL: archived session(archived_at != null) → listActiveMembers 不返回(对比 invariant)', () => {
      // 反向 invariant: lifecycle='active' 但 archived_at 非 null 的 session 不在 active members
      insertSession(db, 'lead-A');
      insertSession(db, 'teammate-archived-Z');

      const team = repo.create({ name: 'archived-test-team' });
      repo.addMember({ teamId: team.id, sessionId: 'lead-A', role: 'lead' });
      repo.addMember({
        teamId: team.id,
        sessionId: 'teammate-archived-Z',
        role: 'teammate',
      });

      // 手动 archive teammate session（设置 archived_at）
      db.prepare(`UPDATE sessions SET archived_at = ? WHERE id = ?`).run(
        2000,
        'teammate-archived-Z',
      );

      // listActiveMembers 仅返回未 archived 的 lead-A（archived_at IS NULL 过滤生效）
      const active = repo.listActiveMembers(team.id);
      const sids = active.map((m) => m.sessionId).sort();
      expect(sids).toEqual(['lead-A']);
      // 对比第一个 case：dormant 仍在 active members（不过滤 lifecycle）；
      // archived 不在 active members（过滤 archived_at）。两个 invariant 同时锁住。
    });
  },
);
