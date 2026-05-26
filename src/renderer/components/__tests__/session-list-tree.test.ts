import { describe, expect, it } from 'vitest';
import type { SessionRecord, SessionTeamMembership } from '@shared/types';
import { computeChildrenByOwner, isPureSpawnChain } from '../session-list-tree';

/**
 * session-list-tree 单测 (plan session-list-handoff-role-badge-20260526 §Step 4.1.5
 * R2 HIGH-B + R3 corner 4+5 mixed role).
 *
 * 覆盖:
 * - isPureSpawnChain 5 corner (self.teams 不空 / child.teams 不空 / owner.teams 不空 /
 *   owner 不在 allSessions silent return true / 全空)
 * - computeChildrenByOwner Phase 1 conditional 5 corner (基础锁 / HIGH-A 反例不锁 /
 *   纯 spawn 锁 / v4 R3 mixed role nested spawn 锁 / v4 R3 teamId 不匹配 confusion 不锁)
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
});
