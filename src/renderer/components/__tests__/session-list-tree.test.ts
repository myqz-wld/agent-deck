import { describe, expect, it } from 'vitest';
import type { SessionRecord, SessionTeamMembership } from '@shared/types';
import { computeChildrenByOwner, isPureSpawnChain } from '../session-list-tree';

/**
 * session-list-tree 单测 (plan session-list-handoff-role-badge-20260526 §Step 4.1.5
 * R2 HIGH-B + R3 corner 4+5 mixed role + REVIEW_65 corner 6/7/8 lead-only regression + mixed escape 修法).
 *
 * 覆盖:
 * - isPureSpawnChain 5 corner (self.teams 不空 / child.teams 不空 / owner.teams 不空 /
 *   owner 不在 allSessions silent return true / 全空)
 * - computeChildrenByOwner Phase 1 conditional 8 corner:
 *   1 基础锁 / 2 HIGH-A 反例不锁 / 3 纯 spawn 锁 / 4 v4 R3 mixed role nested spawn 锁 /
 *   5 v4 R3 teamId 不匹配 confusion 不锁 / 6 REVIEW_65 lead-only mid-tier 锁(防飘 root)/
 *   7 REVIEW_65 mixed lead+teammate 严格化走 Phase 2 接 /
 *   8 REVIEW_65 mixed-child HIGH-A escape 反例(stale owner 仅与 child lead 那一面重合,严格化必须
 *     按 teammate 那一面判定 → Phase 2 reparent)
 */

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess-test',
    agentId: 'claude-code',
    cwd: '/test',
    title: 'Test Session',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    endedAt: null,
    archivedAt: null,
    ...overrides,
  } as SessionRecord;
}

function makeTeam(role: 'lead' | 'teammate', teamId = 'team-x'): SessionTeamMembership {
  return {
    teamId,
    teamName: 'Test Team',
    role,
    joinedAt: Date.now(),
  };
}

describe('isPureSpawnChain', () => {
  it('corner 1: self.teams 不空 → false (priority 1 短路)', () => {
    const self = makeSession({ id: 'A', teams: [makeTeam('lead')] });
    expect(isPureSpawnChain(self, [], [self])).toBe(false);
  });

  it('corner 2: 任一 child.teams 不空 → false (主修复 archive_caller=false 反例 caller 自身)', () => {
    const self = makeSession({ id: 'A', teams: [] });
    const child = makeSession({ id: 'B', teams: [makeTeam('teammate')] });
    expect(isPureSpawnChain(self, [child], [self, child])).toBe(false);
  });

  it('corner 3: 有 spawnedBy + owner 在 allSessions 且 owner.teams 不空 → false', () => {
    const owner = makeSession({ id: 'A', teams: [makeTeam('lead')] });
    const self = makeSession({ id: 'B', spawnedBy: 'A', teams: [] });
    expect(isPureSpawnChain(self, [], [owner, self])).toBe(false);
  });

  it('corner 4: 有 spawnedBy 但 owner 不在 allSessions (跨 section silent) → true (预期防御行为)', () => {
    const self = makeSession({ id: 'B', spawnedBy: 'A-not-in-list', teams: [] });
    expect(isPureSpawnChain(self, [], [self])).toBe(true);
  });

  it('corner 5: 全空 (无 self.teams, 无 children, 无 owner) → true (纯 spawn root)', () => {
    const self = makeSession({ id: 'A', teams: [] });
    expect(isPureSpawnChain(self, [], [self])).toBe(true);
  });
});

describe('computeChildrenByOwner Phase 1 conditional', () => {
  it('corner 1 (基础锁): child has universal team + spawn owner is child team active lead → 锁 claimedBySpawn', () => {
    // A (T1 lead) spawn B (T1 teammate)
    const A = makeSession({ id: 'A', teams: [makeTeam('lead', 'T1')] });
    const B = makeSession({
      id: 'B',
      spawnedBy: 'A',
      teams: [makeTeam('teammate', 'T1')],
    });
    const result = computeChildrenByOwner([A, B]);
    expect(result.claimedBySpawn.has('B')).toBe(true);
    expect(result.childrenByOwner.get('A')).toEqual([B]);
    expect(result.roots).toEqual([A]);
  });

  it('corner 2 (HIGH-A 反例): child has universal team + spawn owner NOT child team active lead → 不锁, Phase 2 reparent', () => {
    // archive_caller:false adopt 反例: A 已 left (teams=[]), D 是新 lead, B 仍 spawnedBy=A
    const A = makeSession({ id: 'A', teams: [] }); // caller, 已 left T1
    const D = makeSession({ id: 'D', teams: [makeTeam('lead', 'T1')] }); // newSid, new T1 lead
    const B = makeSession({
      id: 'B',
      spawnedBy: 'A',
      teams: [makeTeam('teammate', 'T1')],
    }); // teammate B 仍指向 stale A
    const result = computeChildrenByOwner([A, D, B]);
    // Phase 1 不锁 B (A 已不是 B 的 T1 lead)
    expect(result.claimedBySpawn.has('B')).toBe(false);
    // Phase 2 收编 B 到 D 下
    expect(result.claimedByTeam.has('B')).toBe(true);
    expect(result.childrenByOwner.get('D')).toEqual([B]);
    // A + D 都是 root (D 因 lead 身份不被任何人收编)
    expect(result.roots.map((s) => s.id).sort()).toEqual(['A', 'D']);
  });

  it('corner 3 (纯 spawn): child no universal team → 直接锁 claimedBySpawn (无 universal team 干扰)', () => {
    // Explorer subagent 场景: A (无 team) spawn B (无 team)
    const A = makeSession({ id: 'A', teams: [] });
    const B = makeSession({ id: 'B', spawnedBy: 'A', teams: [] });
    const result = computeChildrenByOwner([A, B]);
    expect(result.claimedBySpawn.has('B')).toBe(true);
    expect(result.childrenByOwner.get('A')).toEqual([B]);
  });

  it('corner 4 (v4 R3 claude MED-2 mixed role nested spawn): owner 有 mixed teams 含 child 的 T2 lead → 锁', () => {
    // B 是 T1 teammate (在 A 下); B 再 spawn C2 加 T2 当 lead → B 同时 T1 teammate + T2 lead
    // C2 是 T2 teammate, spawnedBy=B
    const A = makeSession({ id: 'A', teams: [makeTeam('lead', 'T1')] });
    const B = makeSession({
      id: 'B',
      spawnedBy: 'A',
      teams: [makeTeam('teammate', 'T1'), makeTeam('lead', 'T2')],
    });
    const C2 = makeSession({
      id: 'C2',
      spawnedBy: 'B',
      teams: [makeTeam('teammate', 'T2')],
    });
    const result = computeChildrenByOwner([A, B, C2]);
    // B 锁在 A 下 (Phase 1 corner 1)
    expect(result.claimedBySpawn.has('B')).toBe(true);
    // C2 锁在 B 下 (Phase 1 corner 4 — owner B 是 C2 的 T2 lead, some 嵌套语义命中)
    expect(result.claimedBySpawn.has('C2')).toBe(true);
    expect(result.childrenByOwner.get('A')).toEqual([B]);
    expect(result.childrenByOwner.get('B')).toEqual([C2]);
    expect(result.roots).toEqual([A]);
  });

  it('corner 5 (v4 R3 claude MED-2 teamId 不匹配 confusion case): owner.teams=[{T1,lead}] 但 child.teams=[{T2,teammate}] (teamId 不匹配) → 不锁 (防 some 早 return 漏判)', () => {
    // 理论 corner: 当前 spawn 路径不可达, 但 cross-team teamId 不匹配的 confusion case 应有单测保护
    const A = makeSession({ id: 'A', teams: [makeTeam('lead', 'T1')] });
    const B = makeSession({
      id: 'B',
      spawnedBy: 'A',
      teams: [makeTeam('teammate', 'T2')], // 注: B 在 T2 是 teammate, A 不是 T2 lead
    });
    const result = computeChildrenByOwner([A, B]);
    // Phase 1 不锁 B (A 不是 B 的 T2 lead, teamId 不匹配)
    expect(result.claimedBySpawn.has('B')).toBe(false);
    // Phase 2 也找不到 T2 lead → B 留在 roots
    expect(result.claimedByTeam.has('B')).toBe(false);
    expect(result.roots.map((s) => s.id).sort()).toEqual(['A', 'B']);
  });

  it('corner 6 (3-layer spawn rendering bug 修法): lead-only mid-tier 节点(B 是 T3 lead,owner A 不在 T3)→ 仍按 spawn-link 锁(防飘成 root 失 3 层关系)', () => {
    // 真实复现 case (mcp list_sessions 数据):
    // L1 = c315c7a4 "agent-deck" teams=[T1 lead, T2 lead]
    // L2 = 45982d7f "mcp-tool-camelCase plan" teams=[T3 lead] spawnedBy=L1
    // L3 = 019e7331 / 6e8aeeba "reviewer-*" teams=[T3 teammate] spawnedBy=L2
    // 修前 bug:L2 的 teams 与 L1 完全不重合(L1 在 T1/T2,L2 在 T3)→ ownerLeadsSomeTeamOfS=false
    // → Phase 1 continue 不锁 L2;L2 是 T3 lead-only,Phase 2 只收 teammate role 不收 L2
    // → L2 飘成 root,3 层关系断裂(UI 显示两棵独立树)
    // 修后:`sHasTeammateRole=false`(L2 无 teammate role),不进 strict check,直接锁 → 3 层重现
    const L1 = makeSession({
      id: 'L1',
      teams: [makeTeam('lead', 'T1'), makeTeam('lead', 'T2')],
    });
    const L2 = makeSession({
      id: 'L2',
      spawnedBy: 'L1',
      teams: [makeTeam('lead', 'T3')], // lead-only,无 teammate role
    });
    const L3a = makeSession({
      id: 'L3a',
      spawnedBy: 'L2',
      teams: [makeTeam('teammate', 'T3')],
    });
    const L3b = makeSession({
      id: 'L3b',
      spawnedBy: 'L2',
      teams: [makeTeam('teammate', 'T3')],
    });
    const result = computeChildrenByOwner([L1, L2, L3a, L3b]);
    // L2 锁 L1 下(Phase 1 lead-only 跳过 strict check)
    expect(result.claimedBySpawn.has('L2')).toBe(true);
    expect(result.childrenByOwner.get('L1')).toEqual([L2]);
    // L3a / L3b 锁 L2 下(Phase 1 owner L2 是 T3 lead,匹配 child T3 teammate)
    expect(result.claimedBySpawn.has('L3a')).toBe(true);
    expect(result.claimedBySpawn.has('L3b')).toBe(true);
    expect(result.childrenByOwner.get('L2')).toEqual([L3a, L3b]);
    // roots 只有 L1(3 层完整树 — L2 lead-only 因 sHasTeammateRole=false 不进 strict 走直锁)
    expect(result.roots.map((s) => s.id).sort()).toEqual(['L1']);
  });

  it('corner 7 (mixed lead+teammate mid-tier 仍走严格化): child 有 teammate role(即使也含 lead)→ 按原 strict 路径走,owner 不 lead 任一 child team → Phase 2 接 teammate 那一面', () => {
    // 变体:L2 既是 T3 lead 又是 T4 teammate,owner L1 与 L2 完全不重合(不是 T3/T4 lead)
    // 修后行为(预期合理):sHasTeammateRole=true(T4),触发严格化,ownerLeadsSomeTeammateTeamOfS=false
    // (L1 在 T1 lead 但 T1 不在 L2 teammate teams)→ Phase 1 continue;Phase 2 找 T4 lead 接 L2
    // T4Lead 是 root 因(a)无 spawnedBy → Phase 1 跳过 + (b)Phase 2 不收 lead role
    const L1 = makeSession({ id: 'L1', teams: [makeTeam('lead', 'T1')] });
    const T4Lead = makeSession({ id: 'T4Lead', teams: [makeTeam('lead', 'T4')] });
    const L2 = makeSession({
      id: 'L2',
      spawnedBy: 'L1',
      teams: [makeTeam('lead', 'T3'), makeTeam('teammate', 'T4')],
    });
    const result = computeChildrenByOwner([L1, T4Lead, L2]);
    // Phase 1 不锁 L2(sHasTeammateRole=true + ownerLeadsSomeTeammateTeamOfS=false)
    expect(result.claimedBySpawn.has('L2')).toBe(false);
    // Phase 2 接 L2 到 T4Lead 下(T4 teammate role 触发收编)
    expect(result.claimedByTeam.has('L2')).toBe(true);
    expect(result.childrenByOwner.get('T4Lead')).toEqual([L2]);
    // L1 + T4Lead 都是 root
    expect(result.roots.map((s) => s.id).sort()).toEqual(['L1', 'T4Lead']);
  });

  it('corner 8 (REVIEW_65 codex HIGH mixed-child HIGH-A escape 反例): stale owner 只与 child lead 那一面重合,严格化按 teammate 那一面判定 → Phase 2 reparent 到真 lead', () => {
    // 反例可达性 (member-crud.ts:136-143 实证同 team 允许 ≤10 lead;swapLead 只动 oldLead+newLead):
    // 1. lead A 起 spawn_session(team=T1) → A=T1 lead, B=T1 teammate
    // 2. A 起 spawn_session(team=T2) → A=T1+T2 lead (A 是多 team lead)
    // 3. A hand_off_session(adopt_teammates=true) 把 T1 lead 转给 D → A.left T1 但仍 leads T2,
    //    D=T1 lead, B 仍 spawnedBy=A
    // 4. B 自己 spawn_session(team=T2) → B=T2 第 2 个 lead (allowed),A 仍 T2 lead
    // 最终状态: A.teams=[T2 lead], D.teams=[T1 lead], B.teams=[T1 teammate, T2 lead], B.spawnedBy=A
    //
    // 修前 (REVIEW_65 之前 v1 修法 ownerLeadsSomeTeamOfS) bug:B 的 strict check 看 owner A 是否
    // lead some team of B → A T2 lead && T2 in B teams=true → 不 continue → B 锁回 stale A,
    // T1 teammate 那一面失去 reparent 到 D 的机会。
    //
    // 修后 (v2 ownerLeadsSomeTeammateTeamOfS) 行为:strict check 只看 B 的 teammate teams=[T1],
    // owner A T2 lead,T2 不在 B teammate teams → ownerLeadsSomeTeammateTeamOfS=false → continue
    // → Phase 2 接 B 到 D(T1 lead)下。
    const A = makeSession({ id: 'A', teams: [makeTeam('lead', 'T2')] }); // stale (left T1)
    const D = makeSession({ id: 'D', teams: [makeTeam('lead', 'T1')] }); // adopted lead
    const B = makeSession({
      id: 'B',
      spawnedBy: 'A',
      teams: [makeTeam('teammate', 'T1'), makeTeam('lead', 'T2')],
    });
    const result = computeChildrenByOwner([A, D, B]);
    // Phase 1 不锁 B(strict 看 teammate teams=[T1],owner A 不 lead T1)
    expect(result.claimedBySpawn.has('B')).toBe(false);
    // Phase 2 接 B 到 D(T1 lead)下
    expect(result.claimedByTeam.has('B')).toBe(true);
    expect(result.childrenByOwner.get('D')).toEqual([B]);
    // A + D 都是 root
    expect(result.roots.map((s) => s.id).sort()).toEqual(['A', 'D']);
  });
});
