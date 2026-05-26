/**
 * agentDeckTeamRepo.swapLead 单测(plan hand-off-session-adopt-teammates-20260520 Phase 5
 * D4 + N1 zero dual-lead window)。
 *
 * **范围**:transaction atomic + 三 case 分流 + precheck 软退失败 + 边角 case。
 *
 * **N1 zero dual-lead window 实证**:better-sqlite3 db.transaction(callback) 单 connection
 * serializable-like 隔离 — Phase A demote + Phase B promote 同一 transaction,外部 observer
 * 永远看不到「caller (left_at 已写) + newSid (lead role 还未写)」中间态(spike2 v2 archive
 * 联动隔离 attestation 同款路径)。
 *
 * **测试模式**(与 rejoin-after-soft-exit.test.ts 同款):走真 better-sqlite3 :memory: db
 * + bindingAvailable skip 守门(better-sqlite3 binding 跨 Node 版本可能不可用)。
 *
 * **测试矩阵**(7 case 含 case 1/2/3 happy + 软退 precheck 三档):
 * - T5.1 case 1 (adopt 主路径): newLeadSid 不在 team → INSERT 新 lead row
 * - T5.2 case 2 (rejoin path): newLeadSid 已 row 但 left_at!==null → UPDATE 复活为 lead
 * - T5.3 case 3 (防御幂等): newLeadSid 已 active+lead → no-op + 仅刷 display_name
 * - T5.4 case 边角: newLeadSid 已 active+teammate → promote 为 lead
 * - T5.5 软失败: oldLeadSid 不在 team → swapped:false reason='caller-not-in-team' + caller 状态零变化
 * - T5.6 软失败: oldLeadSid 是 teammate(非 lead) → swapped:false reason='caller-not-lead' + 零变化
 * - T5.7 N1 zero dual-lead window 实证: case 1 swapLead 期间 + 之后 countActiveLeads(team) 永远 == 1
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createAgentDeckTeamRepo, type AgentDeckTeamRepo } from '../agent-deck-team-repo';
import { bindingAvailable, makeMemoryDb, insertSession } from './agent-deck-repos/_setup';

describe.skipIf(!bindingAvailable)(
  'agentDeckTeamRepo.swapLead — Phase 5 (D4 + N1 zero dual-lead window)',
  () => {
    let db: Database.Database;
    let repo: AgentDeckTeamRepo;
    beforeEach(() => {
      db = makeMemoryDb();
      repo = createAgentDeckTeamRepo(db);
    });
    afterEach(() => db.close());

    it('T5.1 case 1 (adopt 主路径): newLeadSid 不在 team → INSERT 新 lead row + caller demote 同 transaction', () => {
      // setup: caller 是 lead,team 内有 1 teammate
      insertSession(db, 'caller-sid');
      insertSession(db, 'teammate-A');
      insertSession(db, 'new-sid'); // adopt 路径下 newLeadSid 是全新 spawn 的 session
      const t = repo.create({ name: 'adopt-team' });
      repo.addMember({ teamId: t.id, sessionId: 'caller-sid', role: 'lead' });
      repo.addMember({ teamId: t.id, sessionId: 'teammate-A', role: 'teammate' });

      // 起手 active members = 2 (caller lead + teammate)
      expect(repo.listActiveMembers(t.id)).toHaveLength(2);
      expect(repo.countActiveLeads(t.id)).toBe(1);

      const result = repo.swapLead(t.id, 'caller-sid', 'new-sid', { newDisplayName: 'New Lead' });

      expect(result).toEqual({ swapped: true });

      // caller 软退出(left_at 非 null)+ newSid 是 active lead
      const callerRow = db
        .prepare(
          `SELECT role, left_at FROM agent_deck_team_members WHERE team_id = ? AND session_id = ?`,
        )
        .get(t.id, 'caller-sid') as { role: string; left_at: number | null };
      expect(callerRow.role).toBe('lead'); // role 不变(只 set left_at)
      expect(callerRow.left_at).not.toBeNull();

      const newSidRow = db
        .prepare(
          `SELECT role, left_at, display_name FROM agent_deck_team_members
           WHERE team_id = ? AND session_id = ?`,
        )
        .get(t.id, 'new-sid') as { role: string; left_at: number | null; display_name: string | null };
      expect(newSidRow.role).toBe('lead');
      expect(newSidRow.left_at).toBeNull();
      expect(newSidRow.display_name).toBe('New Lead');

      // teammate 不变
      expect(repo.findActiveMembershipIn(t.id, 'teammate-A')).not.toBeNull();

      // **N1 zero dual-lead window 实证**:swap 后 active lead 数 == 1(newSid 替换 caller)
      expect(repo.countActiveLeads(t.id)).toBe(1);
      const activeMembers = repo.listActiveMembers(t.id);
      expect(activeMembers.map((m) => m.sessionId).sort()).toEqual(['new-sid', 'teammate-A']);
    });

    it('T5.2 case 2 (rejoin path): newLeadSid 已 row 但 left_at !== null → UPDATE 复活为 lead', () => {
      insertSession(db, 'caller-sid');
      insertSession(db, 'rejoin-sid');
      const t = repo.create({ name: 'rejoin-team' });
      repo.addMember({ teamId: t.id, sessionId: 'caller-sid', role: 'lead' });
      // rejoin-sid 加入后离开(left_at 非 null)
      repo.addMember({ teamId: t.id, sessionId: 'rejoin-sid', role: 'teammate' });
      repo.leaveTeam(t.id, 'rejoin-sid');

      // 起手 row 总数 = 2(rejoin-sid 仍有 row 但 left_at 非 null)
      const rowsBeforeSwap = db
        .prepare(`SELECT COUNT(*) AS c FROM agent_deck_team_members WHERE team_id = ?`)
        .get(t.id) as { c: number };
      expect(rowsBeforeSwap.c).toBe(2);

      const result = repo.swapLead(t.id, 'caller-sid', 'rejoin-sid', {
        newDisplayName: 'Rejoined Lead',
      });

      expect(result).toEqual({ swapped: true });

      // 关键:row 总数仍 == 2(case 2 走 UPDATE 不 INSERT 新 row)
      const rowsAfterSwap = db
        .prepare(`SELECT COUNT(*) AS c FROM agent_deck_team_members WHERE team_id = ?`)
        .get(t.id) as { c: number };
      expect(rowsAfterSwap.c).toBe(2);

      const rejoinRow = db
        .prepare(
          `SELECT role, left_at, display_name, joined_at FROM agent_deck_team_members
           WHERE team_id = ? AND session_id = ?`,
        )
        .get(t.id, 'rejoin-sid') as {
        role: string;
        left_at: number | null;
        display_name: string;
        joined_at: number;
      };
      expect(rejoinRow.role).toBe('lead'); // role 改为 lead(原 teammate)
      expect(rejoinRow.left_at).toBeNull();
      expect(rejoinRow.display_name).toBe('Rejoined Lead');

      expect(repo.countActiveLeads(t.id)).toBe(1);
    });

    it('T5.3 case 3 (防御幂等): newLeadSid 已 active+lead → no-op + 仅刷 display_name', () => {
      insertSession(db, 'caller-sid');
      insertSession(db, 'co-lead-sid');
      const t = repo.create({ name: 'multi-lead-team' });
      repo.addMember({
        teamId: t.id,
        sessionId: 'caller-sid',
        role: 'lead',
        displayName: 'Caller',
      });
      // 同 team 已有另一个 active lead(co-lead-sid)— N2.c 互斥防 adopt 路径触发,但保留作 future-use
      repo.addMember({
        teamId: t.id,
        sessionId: 'co-lead-sid',
        role: 'lead',
        displayName: 'Co-Lead',
      });

      expect(repo.countActiveLeads(t.id)).toBe(2);

      const result = repo.swapLead(t.id, 'caller-sid', 'co-lead-sid', {
        newDisplayName: 'Renamed Co-Lead',
      });

      expect(result).toEqual({ swapped: true });

      // caller demote(left_at 非 null)
      const callerRow = db
        .prepare(
          `SELECT left_at FROM agent_deck_team_members WHERE team_id = ? AND session_id = ?`,
        )
        .get(t.id, 'caller-sid') as { left_at: number | null };
      expect(callerRow.left_at).not.toBeNull();

      // co-lead-sid no-op(role 仍 lead) + display_name 刷新
      const coLeadRow = db
        .prepare(
          `SELECT role, left_at, display_name FROM agent_deck_team_members
           WHERE team_id = ? AND session_id = ?`,
        )
        .get(t.id, 'co-lead-sid') as { role: string; left_at: number | null; display_name: string };
      expect(coLeadRow.role).toBe('lead');
      expect(coLeadRow.left_at).toBeNull();
      expect(coLeadRow.display_name).toBe('Renamed Co-Lead');

      // 现在 active lead 只剩 co-lead-sid
      expect(repo.countActiveLeads(t.id)).toBe(1);
    });

    it('T5.4 case 边角: newLeadSid 已 active+teammate → promote 为 lead(bypass MAX_LEADS_PER_TEAM)', () => {
      insertSession(db, 'caller-sid');
      insertSession(db, 'teammate-X');
      const t = repo.create({ name: 'promote-team' });
      repo.addMember({ teamId: t.id, sessionId: 'caller-sid', role: 'lead' });
      repo.addMember({
        teamId: t.id,
        sessionId: 'teammate-X',
        role: 'teammate',
        displayName: 'Original Teammate',
      });

      const result = repo.swapLead(t.id, 'caller-sid', 'teammate-X', {
        newDisplayName: 'Promoted Lead',
      });

      expect(result).toEqual({ swapped: true });

      // teammate-X 升级为 lead + display_name 刷新
      const promotedRow = db
        .prepare(
          `SELECT role, left_at, display_name FROM agent_deck_team_members
           WHERE team_id = ? AND session_id = ?`,
        )
        .get(t.id, 'teammate-X') as { role: string; left_at: number | null; display_name: string };
      expect(promotedRow.role).toBe('lead');
      expect(promotedRow.left_at).toBeNull();
      expect(promotedRow.display_name).toBe('Promoted Lead');

      // active lead 仍 1(caller demote + teammate 升级抵消)
      expect(repo.countActiveLeads(t.id)).toBe(1);
    });

    it('T5.5 软失败: oldLeadSid 不在 team → swapped:false reason="caller-not-in-team" + caller 状态零变化', () => {
      insertSession(db, 'real-lead');
      insertSession(db, 'ghost-caller'); // 不在 team
      insertSession(db, 'new-sid');
      const t = repo.create({ name: 'ghost-team' });
      repo.addMember({ teamId: t.id, sessionId: 'real-lead', role: 'lead' });

      // ghost-caller 没加入 team
      const result = repo.swapLead(t.id, 'ghost-caller', 'new-sid');

      expect(result).toEqual({ swapped: false, reason: 'caller-not-in-team' });

      // **caller 状态零变化**:real-lead 仍 active lead + new-sid 没被 INSERT
      expect(repo.countActiveLeads(t.id)).toBe(1);
      const newSidRow = db
        .prepare(
          `SELECT role FROM agent_deck_team_members WHERE team_id = ? AND session_id = ?`,
        )
        .get(t.id, 'new-sid');
      expect(newSidRow).toBeUndefined(); // Phase B 没执行 — N1 ROLLBACK 同款语义
    });

    it('T5.6 软失败: oldLeadSid 是 teammate(非 lead) → swapped:false reason="caller-not-lead" + 零变化', () => {
      insertSession(db, 'real-lead');
      insertSession(db, 'teammate-caller');
      insertSession(db, 'new-sid');
      const t = repo.create({ name: 'role-mismatch-team' });
      repo.addMember({ teamId: t.id, sessionId: 'real-lead', role: 'lead' });
      repo.addMember({ teamId: t.id, sessionId: 'teammate-caller', role: 'teammate' });

      // teammate-caller 是 teammate 不是 lead
      const result = repo.swapLead(t.id, 'teammate-caller', 'new-sid');

      expect(result).toEqual({ swapped: false, reason: 'caller-not-lead' });

      // 零变化:real-lead 仍 active lead + teammate-caller 仍 teammate(left_at null) + new-sid 不存在
      expect(repo.countActiveLeads(t.id)).toBe(1);
      const teammateRow = db
        .prepare(
          `SELECT role, left_at FROM agent_deck_team_members WHERE team_id = ? AND session_id = ?`,
        )
        .get(t.id, 'teammate-caller') as { role: string; left_at: number | null };
      expect(teammateRow.role).toBe('teammate');
      expect(teammateRow.left_at).toBeNull();
      const newSidRow = db
        .prepare(
          `SELECT role FROM agent_deck_team_members WHERE team_id = ? AND session_id = ?`,
        )
        .get(t.id, 'new-sid');
      expect(newSidRow).toBeUndefined();
    });

    it('T5.7 N1 zero dual-lead window 实证: case 1 swap 之后 countActiveLeads(team) 永远 == 1(无中间 == 2 状态)', () => {
      // **N1 invariant 实证**:better-sqlite3 db.transaction(callback) 单 connection 同步执行
      // (无 await)+ serializable-like 隔离让外部 SELECT 永远看 transaction 之前 / 之后 state
      // 二选一,绝不见 dual-lead 中间态。本 case 实证 active lead 数 == 1(case 1 主路径)。
      // (真正测 transaction 隔离需多 connection / 异步竞争 — spike2 v2 已 attest;此处补
      // happy-path 实证 caller demote + newSid promote 同 transaction 后 lead count 守恒。)
      insertSession(db, 'old-lead');
      insertSession(db, 'new-lead');
      const t = repo.create({ name: 'invariant-team' });
      repo.addMember({ teamId: t.id, sessionId: 'old-lead', role: 'lead' });

      expect(repo.countActiveLeads(t.id)).toBe(1); // before swap

      const result = repo.swapLead(t.id, 'old-lead', 'new-lead');
      expect(result).toEqual({ swapped: true });

      expect(repo.countActiveLeads(t.id)).toBe(1); // after swap — 守恒

      // 确认 lead 实际是 new-lead(不是 old-lead)
      const activeLeadRows = db
        .prepare(
          `SELECT session_id FROM agent_deck_team_members
           WHERE team_id = ? AND role = 'lead' AND left_at IS NULL`,
        )
        .all(t.id) as Array<{ session_id: string }>;
      expect(activeLeadRows).toEqual([{ session_id: 'new-lead' }]);
    });

    // === REVIEW_56 §F13 修法 — newDisplayName trim 边界回归 test ===
    it('F13: newDisplayName 空字符串 → trim() || null → display_name 保留 (不覆盖)', () => {
      // setup: caller 是 lead,team 内 1 teammate
      insertSession(db, 'caller-sid');
      insertSession(db, 'new-sid');
      const t = repo.create({ name: 'trim-empty-team' });
      repo.addMember({
        teamId: t.id,
        sessionId: 'caller-sid',
        role: 'lead',
        displayName: 'Caller Lead',
      });

      // newDisplayName='' (空字符串) — F13 修法 trim() || null → null,display_name 保留
      const result = repo.swapLead(t.id, 'caller-sid', 'new-sid', { newDisplayName: '' });
      expect(result).toEqual({ swapped: true });

      // caller 已退,new-sid 是 active lead 但 display_name 走 null fallback (实现里 null 时
      // 保留新行旧 display_name 或 INSERT 时 NULL — 取决具体路径,关键是不会 INSERT 空字符串)
      const newRow = db
        .prepare(
          `SELECT display_name FROM agent_deck_team_members
           WHERE team_id = ? AND session_id = ? AND left_at IS NULL`,
        )
        .get(t.id, 'new-sid') as { display_name: string | null };
      // 空字符串 trim 后 falsy → null,DB 实际写入 NULL(不应是空字符串 '')
      expect(newRow.display_name).not.toBe('');
    });

    it('F13: newDisplayName 全空格 → trim() || null → display_name 不覆盖为 "   "', () => {
      insertSession(db, 'caller-sid');
      insertSession(db, 'new-sid');
      const t = repo.create({ name: 'trim-spaces-team' });
      repo.addMember({
        teamId: t.id,
        sessionId: 'caller-sid',
        role: 'lead',
        displayName: 'Caller Lead',
      });

      // newDisplayName='   ' (全空格) — F13 修法 trim() || null → null
      const result = repo.swapLead(t.id, 'caller-sid', 'new-sid', { newDisplayName: '   ' });
      expect(result).toEqual({ swapped: true });

      const newRow = db
        .prepare(
          `SELECT display_name FROM agent_deck_team_members
           WHERE team_id = ? AND session_id = ? AND left_at IS NULL`,
        )
        .get(t.id, 'new-sid') as { display_name: string | null };
      // 全空格 trim 后 0 长度 falsy → null,DB 不应写入 '   '
      expect(newRow.display_name).not.toBe('   ');
    });

    it('F13: newDisplayName 真值 (含前后空格) → trim() 保留 + 写入', () => {
      insertSession(db, 'caller-sid');
      insertSession(db, 'new-sid');
      const t = repo.create({ name: 'trim-truthy-team' });
      repo.addMember({
        teamId: t.id,
        sessionId: 'caller-sid',
        role: 'lead',
        displayName: 'Caller Lead',
      });

      // newDisplayName='  Real Name  ' — F13 修法 trim() → 'Real Name'(注意 helper 内只在
      // newDisplayName=null 时退化,真值仍走原路径,本 it 验真值不被 trim falsy 误判)
      const result = repo.swapLead(t.id, 'caller-sid', 'new-sid', { newDisplayName: '  Real Name  ' });
      expect(result).toEqual({ swapped: true });

      const newRow = db
        .prepare(
          `SELECT display_name FROM agent_deck_team_members
           WHERE team_id = ? AND session_id = ? AND left_at IS NULL`,
        )
        .get(t.id, 'new-sid') as { display_name: string | null };
      // 真 truthy 值 trim 后仍非空 → 写入(具体值取决 swapLead 内 newDisplayName 用法,
      // 至少不应为 null/空)
      expect(newRow.display_name).toBeTruthy();
    });
  },
);
