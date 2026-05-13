/**
 * manager-team-coordinator characterization test (plan mcp-bug-and-feature-batch-20260513
 * Phase 2 Step 2.4 / H 修)
 *
 * H 修目标：H4 把 _leaveAllActiveTeams (close/markClosed) 与 delete() 段 1 (delete) 合并
 * 成 leaveTeamsAndAutoArchive(sid, reason)，archive reason 由 satisfies map explicit 区分。
 * 验证当时只靠代码 diff，缺一个独立 characterization test 覆盖：
 * - leaveTeam → emit member-changed → countActiveLeads → 0-lead → archive → emit team-updated
 * - 分别断言 closed/deleted 两条 reason 分支对应 'last-lead-closed' / 'last-lead-deleted'
 *
 * 不依赖真 SQLite / Electron / SDK：vi.mock 替换 agent-deck-team-repo / event-bus。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentDeckTeam, AgentDeckTeamMember } from '@shared/types';

// ─── Mock setup ─────────────────────────────────────────────────────────

const leaveTeamCalls: Array<{ teamId: string; sessionId: string }> = [];
const countActiveLeadsCalls: string[] = [];
const archiveCalls: Array<{ teamId: string; reason?: string }> = [];
const emitCalls: Array<{ name: string; payload: unknown }> = [];

let nextActiveMemberships: AgentDeckTeamMember[] = [];
let nextCountActiveLeads = 0;
let nextArchiveResult: AgentDeckTeam | null = null;

vi.mock('@main/store/agent-deck-team-repo', () => ({
  agentDeckTeamRepo: {
    findActiveMembershipsBySession: () => nextActiveMemberships,
    leaveTeam: (teamId: string, sessionId: string) => {
      leaveTeamCalls.push({ teamId, sessionId });
      return null;
    },
    countActiveLeads: (teamId: string) => {
      countActiveLeadsCalls.push(teamId);
      return nextCountActiveLeads;
    },
    archive: (teamId: string, opts?: { reason?: string }) => {
      archiveCalls.push({ teamId, reason: opts?.reason });
      return nextArchiveResult;
    },
    // 其他 method 不在本 helper 路径，留 stub
    get: () => null,
    unarchive: () => null,
  },
}));

vi.mock('@main/event-bus', () => ({
  eventBus: {
    emit: (name: string, payload: unknown) => {
      emitCalls.push({ name, payload });
    },
    on: () => () => {},
  },
}));

// import after mocks
import { leaveTeamsAndAutoArchive } from '@main/session/manager-team-coordinator';

// ─── Helpers ────────────────────────────────────────────────────────────

function makeMembership(overrides: Partial<AgentDeckTeamMember> = {}): AgentDeckTeamMember {
  return {
    teamId: 'team-1',
    sessionId: 'sid-1',
    role: 'lead',
    joinedAt: 1000,
    leftAt: null,
    displayName: null,
    ...overrides,
  };
}

function makeTeam(overrides: Partial<AgentDeckTeam> = {}): AgentDeckTeam {
  return {
    id: 'team-1',
    name: 'Team 1',
    archivedAt: 9999,
    archiveReason: 'last-lead-closed',
    createdAt: 1000,
    metadata: {},
    ...overrides,
  };
}

beforeEach(() => {
  leaveTeamCalls.length = 0;
  countActiveLeadsCalls.length = 0;
  archiveCalls.length = 0;
  emitCalls.length = 0;
  nextActiveMemberships = [];
  nextCountActiveLeads = 0;
  nextArchiveResult = null;
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe('leaveTeamsAndAutoArchive - characterization (H 修 / H1.5 follow-up)', () => {
  it('reason="closed" 走 archive_reason="last-lead-closed" + emit team-updated', async () => {
    nextActiveMemberships = [makeMembership({ teamId: 'team-A', sessionId: 'lead-A' })];
    nextCountActiveLeads = 0; // 0-lead 触发 archive
    nextArchiveResult = makeTeam({ id: 'team-A', archiveReason: 'last-lead-closed' });

    await leaveTeamsAndAutoArchive('lead-A', 'closed');

    // 1. leaveTeam called
    expect(leaveTeamCalls).toEqual([{ teamId: 'team-A', sessionId: 'lead-A' }]);
    // 2. emit team-member-changed
    expect(emitCalls).toContainEqual({
      name: 'agent-deck-team-member-changed',
      payload: { teamId: 'team-A', sessionId: 'lead-A', kind: 'left' },
    });
    // 3. countActiveLeads check
    expect(countActiveLeadsCalls).toEqual(['team-A']);
    // 4. 0-lead → archive 用 'last-lead-closed' reason
    expect(archiveCalls).toEqual([{ teamId: 'team-A', reason: 'last-lead-closed' }]);
    // 5. emit team-updated
    expect(emitCalls).toContainEqual({
      name: 'agent-deck-team-updated',
      payload: nextArchiveResult,
    });
  });

  it('reason="deleted" 走 archive_reason="last-lead-deleted"（区分 closed 路径）', async () => {
    nextActiveMemberships = [makeMembership({ teamId: 'team-B', sessionId: 'lead-B' })];
    nextCountActiveLeads = 0;
    nextArchiveResult = makeTeam({ id: 'team-B', archiveReason: 'last-lead-deleted' });

    await leaveTeamsAndAutoArchive('lead-B', 'deleted');

    expect(leaveTeamCalls).toEqual([{ teamId: 'team-B', sessionId: 'lead-B' }]);
    // 关键差异：reason 区分
    expect(archiveCalls).toEqual([{ teamId: 'team-B', reason: 'last-lead-deleted' }]);
  });

  it('剩余 active lead > 0 时不 archive（仅 leave + emit member-changed）', async () => {
    nextActiveMemberships = [makeMembership({ teamId: 'team-C', sessionId: 'lead-C1' })];
    nextCountActiveLeads = 1; // 还有别的 active lead
    nextArchiveResult = null;

    await leaveTeamsAndAutoArchive('lead-C1', 'closed');

    // leaveTeam + member-changed 仍走
    expect(leaveTeamCalls).toEqual([{ teamId: 'team-C', sessionId: 'lead-C1' }]);
    expect(emitCalls.filter((e) => e.name === 'agent-deck-team-member-changed')).toHaveLength(1);
    // countActiveLeads 检查后不 archive
    expect(countActiveLeadsCalls).toEqual(['team-C']);
    expect(archiveCalls).toHaveLength(0);
    expect(emitCalls.filter((e) => e.name === 'agent-deck-team-updated')).toHaveLength(0);
  });

  it('多 membership 时分别处理，各自走完整 leave→countActiveLeads→archive 链', async () => {
    nextActiveMemberships = [
      makeMembership({ teamId: 'team-X', sessionId: 'multi' }),
      makeMembership({ teamId: 'team-Y', sessionId: 'multi' }),
    ];
    nextCountActiveLeads = 0;
    nextArchiveResult = makeTeam();

    await leaveTeamsAndAutoArchive('multi', 'closed');

    expect(leaveTeamCalls).toEqual([
      { teamId: 'team-X', sessionId: 'multi' },
      { teamId: 'team-Y', sessionId: 'multi' },
    ]);
    expect(countActiveLeadsCalls).toEqual(['team-X', 'team-Y']);
    expect(archiveCalls.map((c) => c.teamId)).toEqual(['team-X', 'team-Y']);
  });

  it('无 membership 时立即返回，不 leave / count / archive', async () => {
    nextActiveMemberships = [];

    await leaveTeamsAndAutoArchive('orphan-sid', 'closed');

    expect(leaveTeamCalls).toHaveLength(0);
    expect(countActiveLeadsCalls).toHaveLength(0);
    expect(archiveCalls).toHaveLength(0);
  });
});
