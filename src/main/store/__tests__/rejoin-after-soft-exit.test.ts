/**
 * F1b team_member rejoin 复活语义校验（plan deep-review-batch-a1-b-followup-r3-20260519
 * §Phase 5.5 / R2 plan-review HIGH-B）。
 *
 * **背景**：plan §F1b 不变量 6 早期描述「不再继承幽灵 team」，R2 plan-review HIGH-B 实证
 * schema PK `(team_id, session_id)` 单一复合主键无 surrogate id 字段，addMember rejoin 是
 * **复活老 row**（UPDATE 同 PK + left_at 重置 NULL + joined_at = now），不是「起新 row」。
 *
 * 本 test 显式 confirm:
 * 1. leaveTeam → team_member.left_at !== null（软退出）
 * 2. addMember 同 (team, session) PK + 老 row left_at 非 null → rejoin 路径（UPDATE，非 INSERT）
 * 3. **row 总数不变**（仍 1 条 row，不是新加 1 条 = 2 条 — schema PK 不允许重复 INSERT）
 * 4. rejoin 后 left_at 重置为 NULL + joined_at 为新时间戳 + role 可改
 *
 * D4 F1b 不变量 6 语义校准（plan §D4 + plan §已知踩坑 #14）：
 * - default 不传 team_name 不进任何旧 team — trivial 当前行为，无 schema 影响
 * - 显式传 team_name 让 caller 加入旧 team 是 rejoin 复活 — 与软退是「caller close 时刻状态镜像」
 *   不冲突：rejoin 是新一轮加入的合理需求
 *
 * 现有 agent-deck-team-repo.test.ts:156 "leaveTeam 写 left_at 不删 row；rejoin 复用同 PK 行" case
 * 已 cover 主路径，本文件加强 row 总数 invariant 显式断言。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createAgentDeckTeamRepo, type AgentDeckTeamRepo } from '../agent-deck-team-repo';
import { bindingAvailable, makeMemoryDb, insertSession } from './agent-deck-repos/_setup';

describe.skipIf(!bindingAvailable)(
  'F1b team_member rejoin 复活语义（plan §Phase 5.5 / R2 HIGH-B）',
  () => {
    let db: Database.Database;
    let repo: AgentDeckTeamRepo;
    beforeEach(() => {
      db = makeMemoryDb();
      repo = createAgentDeckTeamRepo(db);
    });
    afterEach(() => db.close());

    it('lead + teammate close → leftAt 非 null；rejoin 复活同 PK row（UPDATE 非 INSERT）+ row 总数不变', () => {
      // 起 lead + teammate
      insertSession(db, 'lead-A');
      insertSession(db, 'teammate-B');
      const t = repo.create({ name: 'baton-team' });
      repo.addMember({ teamId: t.id, sessionId: 'lead-A', role: 'lead' });
      repo.addMember({ teamId: t.id, sessionId: 'teammate-B', role: 'teammate' });

      // 起手 row 总数（含 lead + teammate）= 2
      const initialRowCount = db
        .prepare(`SELECT COUNT(*) AS c FROM agent_deck_team_members WHERE team_id = ?`)
        .get(t.id) as { c: number };
      expect(initialRowCount.c).toBe(2);

      // close teammate（leaveTeam 写 left_at = now，不删 row）
      const leftMember = repo.leaveTeam(t.id, 'teammate-B');
      expect(leftMember).not.toBeNull();
      expect(leftMember!.leftAt).not.toBeNull();
      expect(leftMember!.leftAt).toBeGreaterThan(0);

      // listActiveMembers 反查不含 left teammate（schema 已过滤 m.left_at IS NULL）
      const activeAfterLeave = repo.listActiveMembers(t.id);
      expect(activeAfterLeave).toHaveLength(1);
      expect(activeAfterLeave[0]?.sessionId).toBe('lead-A');

      // listAllMembers 仍含 left teammate（历史保留）
      const allAfterLeave = repo.listAllMembers(t.id);
      expect(allAfterLeave).toHaveLength(2);
      const leftRow = allAfterLeave.find((m) => m.sessionId === 'teammate-B');
      expect(leftRow!.leftAt).not.toBeNull();

      // row 总数不变（leaveTeam 是 UPDATE，不是 DELETE）
      const rowCountAfterLeave = db
        .prepare(`SELECT COUNT(*) AS c FROM agent_deck_team_members WHERE team_id = ?`)
        .get(t.id) as { c: number };
      expect(rowCountAfterLeave.c).toBe(2);

      // 关键: rejoin 复活老 row（UPDATE 同 PK，非 INSERT 起新 row）
      // 角色变更（teammate → lead），让断言不仅 confirm 复活，也 confirm rejoin 可改 role
      const oldJoinedAt = leftRow!.joinedAt;
      // 等待 1ms 确保 joinedAt 时间戳变化
      const beforeRejoin = Date.now();
      while (Date.now() === beforeRejoin) {
        // spin until next ms
      }
      const rejoined = repo.addMember({
        teamId: t.id,
        sessionId: 'teammate-B',
        role: 'lead', // 改成 lead 看 role 是否被 rejoin 更新
      });
      // assert: rejoin 字段更新到位
      expect(rejoined.sessionId).toBe('teammate-B');
      expect(rejoined.leftAt).toBeNull();
      expect(rejoined.role).toBe('lead');
      expect(rejoined.joinedAt).toBeGreaterThan(oldJoinedAt);

      // 关键 invariant: row 总数仍 = 2（rejoin 是 UPDATE，不是 INSERT 起新 row）
      // schema PK (team_id, session_id) 复合主键不允许重复 INSERT，rejoin 必须走 UPDATE 老 row
      const rowCountAfterRejoin = db
        .prepare(`SELECT COUNT(*) AS c FROM agent_deck_team_members WHERE team_id = ?`)
        .get(t.id) as { c: number };
      expect(rowCountAfterRejoin.c).toBe(2);

      // listActiveMembers 反查 lead-A + rejoined teammate-B（含 2 个 lead）
      const activeAfterRejoin = repo.listActiveMembers(t.id);
      expect(activeAfterRejoin).toHaveLength(2);
      expect(activeAfterRejoin.find((m) => m.sessionId === 'teammate-B')?.role).toBe('lead');
    });

    it('rejoin 后再 leaveTeam → 再 rejoin 仍是同一 row（多轮复活语义）', () => {
      // 极端 invariant: 多轮 leaveTeam → rejoin → leaveTeam → rejoin 仍是 same PK row,
      // row 总数始终 = 1
      insertSession(db, 'sX');
      const t = repo.create({ name: 'multi-cycle' });
      repo.addMember({ teamId: t.id, sessionId: 'sX', role: 'teammate' });

      const initial = db
        .prepare(`SELECT COUNT(*) AS c FROM agent_deck_team_members WHERE session_id = ?`)
        .get('sX') as { c: number };
      expect(initial.c).toBe(1);

      // 第一轮 leave + rejoin
      repo.leaveTeam(t.id, 'sX');
      expect(repo.listActiveMembers(t.id)).toHaveLength(0);
      const r1 = repo.addMember({ teamId: t.id, sessionId: 'sX', role: 'teammate' });
      expect(r1.leftAt).toBeNull();
      expect(
        (db.prepare(`SELECT COUNT(*) AS c FROM agent_deck_team_members WHERE session_id = ?`)
          .get('sX') as { c: number }).c,
      ).toBe(1);

      // 第二轮 leave + rejoin
      repo.leaveTeam(t.id, 'sX');
      expect(repo.listActiveMembers(t.id)).toHaveLength(0);
      const r2 = repo.addMember({ teamId: t.id, sessionId: 'sX', role: 'lead' });
      expect(r2.leftAt).toBeNull();
      expect(r2.role).toBe('lead');
      expect(
        (db.prepare(`SELECT COUNT(*) AS c FROM agent_deck_team_members WHERE session_id = ?`)
          .get('sX') as { c: number }).c,
      ).toBe(1);
    });

    it('rejoin 时同时 active 抛 TeamInvariantError（不允许 active 重复 add）', () => {
      // 防 confused state: active member 不能再 addMember（plan §F1b 软退「保留 caller 在
      // close 时刻状态镜像」前提是先有 leaveTeam,如未离开就重复 add 应被严格拒）
      insertSession(db, 'sY');
      const t = repo.create({ name: 'no-double-add' });
      repo.addMember({ teamId: t.id, sessionId: 'sY', role: 'teammate' });

      expect(() =>
        repo.addMember({ teamId: t.id, sessionId: 'sY', role: 'lead' }),
      ).toThrow(/already active/);
    });
  },
);
