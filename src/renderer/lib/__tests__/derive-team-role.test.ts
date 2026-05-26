import { describe, expect, it } from 'vitest';
import type { SessionRecord, SessionTeamMembership } from '@shared/types';
import { deriveTeamRole } from '../derive-team-role';

/**
 * deriveTeamRole 单测 (plan session-list-handoff-role-badge-20260526 §Step 4.1):
 * - 优先级 1: universal team backend membership (任一 lead → lead, 否则 teammate)
 * - 优先级 2: spawn-link 退化 (仅 pureSpawnChain=true 时)
 *
 * 11 corner 覆盖 (v4 含 case 10/11 hasOwner=true 路径双向 - R2 claude MED-1):
 *   1-2: teams 字段缺失 / 空数组 + 无 spawn 链 → undefined
 *   3-7: universal team backend 各 role 形态
 *   8-9: spawn-link 退化 owner 视角 (HIGH-2 反例 9 验证 pureSpawnChain=false 阻断)
 *   10-11: spawn-link 退化 children 视角 (HIGH-2 反例 11 验证 pureSpawnChain=false 阻断 hasOwner)
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

describe('deriveTeamRole', () => {
  it('case 1: teams=undefined + pureSpawnChain=true + hasOwner=false + 0 children → undefined', () => {
    const s = makeSession({ teams: undefined });
    expect(deriveTeamRole(s, false, 0, true)).toBeUndefined();
  });

  it('case 2: teams=[] + pureSpawnChain=true + hasOwner=false + 0 children → undefined', () => {
    const s = makeSession({ teams: [] });
    expect(deriveTeamRole(s, false, 0, true)).toBeUndefined();
  });

  it('case 3: teams=[{role:lead}] → lead (universal team priority)', () => {
    const s = makeSession({ teams: [makeTeam('lead')] });
    expect(deriveTeamRole(s, false, 0, true)).toBe('lead');
  });

  it('case 4: teams=[{role:teammate}] → teammate (universal team priority)', () => {
    const s = makeSession({ teams: [makeTeam('teammate')] });
    expect(deriveTeamRole(s, false, 0, true)).toBe('teammate');
  });

  it('case 5: teams=[{lead},{lead}] (multi-team all lead) → lead', () => {
    const s = makeSession({
      teams: [makeTeam('lead', 'team-a'), makeTeam('lead', 'team-b')],
    });
    expect(deriveTeamRole(s, false, 0, true)).toBe('lead');
  });

  it('case 6: teams=[{teammate},{teammate}] (multi-team all teammate) → teammate', () => {
    const s = makeSession({
      teams: [makeTeam('teammate', 'team-a'), makeTeam('teammate', 'team-b')],
    });
    expect(deriveTeamRole(s, false, 0, true)).toBe('teammate');
  });

  it('case 7: teams=[{teammate},{lead}] (mixed, nested spawn 当前可达) → lead (任一 lead 优先 §D5)', () => {
    const s = makeSession({
      teams: [makeTeam('teammate', 'team-1'), makeTeam('lead', 'team-2')],
    });
    expect(deriveTeamRole(s, false, 0, true)).toBe('lead');
  });

  it('case 8: teams=[] + pureSpawnChain=true + childrenCount=2 + hasOwner=false → lead (纯 spawn 链 owner)', () => {
    const s = makeSession({ teams: [] });
    expect(deriveTeamRole(s, false, 2, true)).toBe('lead');
  });

  it('case 9 (HIGH-2 反例 owner 视角): teams=[] + pureSpawnChain=false + childrenCount=2 → undefined (children 含 universal team → 不能误标 lead)', () => {
    const s = makeSession({ teams: [] });
    expect(deriveTeamRole(s, false, 2, false)).toBeUndefined();
  });

  it('case 10 (v4 R2 claude MED-1 case A): teams=[] + pureSpawnChain=true + hasOwner=true + childrenCount=0 → teammate (纯 spawn 子节点 fallback)', () => {
    const s = makeSession({ teams: [] });
    expect(deriveTeamRole(s, true, 0, true)).toBe('teammate');
  });

  it('case 11 (v4 R2 claude MED-1 case B / HIGH-2 反例 children 视角): teams=[] + pureSpawnChain=false + hasOwner=true → undefined (owner 含 universal team → 不能误标 teammate)', () => {
    const s = makeSession({ teams: [] });
    expect(deriveTeamRole(s, true, 0, false)).toBeUndefined();
  });
});
