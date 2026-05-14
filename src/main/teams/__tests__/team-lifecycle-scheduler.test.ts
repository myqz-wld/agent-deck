/**
 * TeamLifecycleScheduler.scan() 单测（REVIEW_33 H4）
 *
 * 关键验证：scan() 必须先收集候选 teamId 再批量 archive，避免边迭代边 archive 导致
 * pagination offset 跳错而漏扫。修前 reviewer-claude node 模拟 500 条全 ghost team
 * 实测漏扫 200 条；修后两阶段保证 500/500 全 archive。
 *
 * 不依赖真实 SQLite / Electron / SDK：vi.mock 替换 sessionRepo / agentDeckTeamRepo /
 * eventBus 三个 dep。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { makeAgentDeckTeamRepoMock } from '@main/__tests__/_shared/mocks/agent-deck-team-repo';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';
import { makeEventBusMock } from '@main/__tests__/_shared/mocks/event-bus';
import type { AgentDeckTeamRepo } from '@main/store/agent-deck-team-repo';

// ─── Mock setup ─────────────────────────────────────────────────────────
// R37 P2-F Step 3.1：5 类 mock 全走 _shared/mocks/ factory + override stateful 行为。

interface FakeTeam {
  id: string;
  name: string;
  archivedAt: number | null;
}

interface FakeMember {
  sessionId: string;
}

interface FakeSession {
  id: string;
  lifecycle: 'active' | 'dormant' | 'closed';
  lastEventAt: number;
}

let teams: FakeTeam[] = [];
let teamMembers: Map<string, FakeMember[]> = new Map();
let sessions: Map<string, FakeSession> = new Map();
const archiveCalls: string[] = [];

vi.mock('@main/store/agent-deck-team-repo', () => ({
  agentDeckTeamRepo: makeAgentDeckTeamRepoMock({
    overrides: {
      list: ((opts?: { activeOnly?: boolean; limit?: number; offset?: number }) => {
        const all = opts?.activeOnly ? teams.filter((t) => t.archivedAt === null) : teams;
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 200;
        return all.slice(offset, offset + limit);
      }) as unknown as AgentDeckTeamRepo['list'],
      listActiveMembers: ((teamId: string) =>
        teamMembers.get(teamId) ?? []) as unknown as AgentDeckTeamRepo['listActiveMembers'],
      archive: ((teamId: string, _opts?: { reason?: string }) => {
        archiveCalls.push(teamId);
        const t = teams.find((x) => x.id === teamId);
        if (!t) return null;
        // 关键：模拟真实 archive 行为 — archived_at 从 NULL 变非 NULL，下次 list({activeOnly:true})
        // 该 team 立刻消失。这正是 H4 漏扫的根因。
        t.archivedAt = Date.now();
        return t;
      }) as unknown as AgentDeckTeamRepo['archive'],
    },
  }),
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({
    overrides: {
      get: (id: string) => sessions.get(id) ?? null,
    },
  }),
}));

const emittedEvents: Array<{ channel: string; payload: unknown }> = [];
vi.mock('@main/event-bus', () => ({
  eventBus: makeEventBusMock({
    overrides: {
      emit: (channel: string, payload: unknown) => {
        emittedEvents.push({ channel, payload });
      },
    },
  }),
}));

// import after mocks
import { TeamLifecycleScheduler } from '@main/teams/team-lifecycle-scheduler';

// ─── Helpers ────────────────────────────────────────────────────────────

function makeGhostFixture(count: number): void {
  teams = [];
  teamMembers = new Map();
  sessions = new Map();
  archiveCalls.length = 0;
  emittedEvents.length = 0;
  for (let i = 0; i < count; i++) {
    const teamId = `team-${i}`;
    teams.push({ id: teamId, name: `Team ${i}`, archivedAt: null });
    teamMembers.set(teamId, []); // 全 ghost：无 active member → 应被 archive
  }
}

function makeMixedFixture(): void {
  teams = [];
  teamMembers = new Map();
  sessions = new Map();
  archiveCalls.length = 0;
  emittedEvents.length = 0;
  // 5 ghost (no members) + 5 alive (active session) + 5 ready-to-archive (closed sessions, grace elapsed)
  for (let i = 0; i < 5; i++) {
    teams.push({ id: `ghost-${i}`, name: `Ghost ${i}`, archivedAt: null });
    teamMembers.set(`ghost-${i}`, []);
  }
  for (let i = 0; i < 5; i++) {
    teams.push({ id: `alive-${i}`, name: `Alive ${i}`, archivedAt: null });
    teamMembers.set(`alive-${i}`, [{ sessionId: `sess-alive-${i}` }]);
    sessions.set(`sess-alive-${i}`, {
      id: `sess-alive-${i}`,
      lifecycle: 'active',
      lastEventAt: Date.now(),
    });
  }
  for (let i = 0; i < 5; i++) {
    teams.push({ id: `closed-${i}`, name: `Closed ${i}`, archivedAt: null });
    teamMembers.set(`closed-${i}`, [{ sessionId: `sess-closed-${i}` }]);
    sessions.set(`sess-closed-${i}`, {
      id: `sess-closed-${i}`,
      lifecycle: 'closed',
      lastEventAt: Date.now() - 60 * 60_000, // 1 小时前 closed → grace（30min）已过
    });
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('TeamLifecycleScheduler.scan() — REVIEW_33 H4 两阶段（先收集后批量 archive）', () => {
  beforeEach(() => {
    teams = [];
    teamMembers = new Map();
    sessions = new Map();
    archiveCalls.length = 0;
    emittedEvents.length = 0;
  });

  it('500 条全 ghost team → 全部被 archive，无漏扫（核心 H4 case：边迭代边 archive 会漏扫 200）', () => {
    makeGhostFixture(500);
    const scheduler = new TeamLifecycleScheduler({ intervalMs: 60_000, graceMs: 30 * 60_000 });
    scheduler.scan();

    // 必须 archive 全部 500 条；修前同 fixture 漏扫 200 条
    expect(archiveCalls.length).toBe(500);
    // 顺序保证：按 team-0..team-499 顺序入候选 → 顺序 archive
    expect(archiveCalls[0]).toBe('team-0');
    expect(archiveCalls[499]).toBe('team-499');
    // 验证全部被真 archive（archived_at 非 NULL）
    expect(teams.every((t) => t.archivedAt !== null)).toBe(true);
  });

  it('PAGE_SIZE 边界：恰好 200 条 ghost → 必须 archive 200 条不少不多', () => {
    makeGhostFixture(200);
    const scheduler = new TeamLifecycleScheduler({ intervalMs: 60_000, graceMs: 30 * 60_000 });
    scheduler.scan();
    expect(archiveCalls.length).toBe(200);
  });

  it('小于 PAGE_SIZE：50 条 ghost → 一页扫完，全部 archive', () => {
    makeGhostFixture(50);
    const scheduler = new TeamLifecycleScheduler({ intervalMs: 60_000, graceMs: 30 * 60_000 });
    scheduler.scan();
    expect(archiveCalls.length).toBe(50);
  });

  it('混合 fixture（5 ghost + 5 alive + 5 closed-grace-elapsed）→ archive 10 条（ghost + closed），跳过 5 alive', () => {
    makeMixedFixture();
    const scheduler = new TeamLifecycleScheduler({ intervalMs: 60_000, graceMs: 30 * 60_000 });
    scheduler.scan();

    expect(archiveCalls.length).toBe(10);
    // 候选包含 ghost-* 和 closed-*，不含 alive-*
    expect(archiveCalls.filter((id) => id.startsWith('ghost-')).length).toBe(5);
    expect(archiveCalls.filter((id) => id.startsWith('closed-')).length).toBe(5);
    expect(archiveCalls.filter((id) => id.startsWith('alive-')).length).toBe(0);
    // alive 的 5 条仍在 active list
    expect(teams.filter((t) => t.id.startsWith('alive-')).every((t) => t.archivedAt === null)).toBe(true);
  });

  it('grace period 未到 → closed session 对应 team 不被 archive（first pass 阶段过滤掉）', () => {
    teams = [{ id: 'fresh-closed', name: 'Fresh Closed', archivedAt: null }];
    teamMembers.set('fresh-closed', [{ sessionId: 'sess-fresh' }]);
    sessions.set('sess-fresh', {
      id: 'sess-fresh',
      lifecycle: 'closed',
      lastEventAt: Date.now() - 5 * 60_000, // 5 分钟前 closed，grace=30min 未到
    });
    archiveCalls.length = 0;

    const scheduler = new TeamLifecycleScheduler({ intervalMs: 60_000, graceMs: 30 * 60_000 });
    scheduler.scan();
    expect(archiveCalls.length).toBe(0);
    expect(teams[0]!.archivedAt).toBe(null);
  });

  it('candidate list 收集阶段不动 archived_at（pagination 在 first pass 全程稳定）', () => {
    // 反向验证策略：300 条全 ghost（跨 2 页：200+100）。如果 first pass 期间 archive
    // 被错触发，pagination offset 跳错 → 最终 archive < 300。修后两阶段 archive 全 300。
    makeGhostFixture(300);
    const scheduler = new TeamLifecycleScheduler({ intervalMs: 60_000, graceMs: 30 * 60_000 });
    scheduler.scan();
    expect(archiveCalls.length).toBe(300);
    // 顺序也验证：first pass 全部收完后 second pass 才按 candidate 顺序 archive
    expect(archiveCalls[0]).toBe('team-0');
    expect(archiveCalls[199]).toBe('team-199'); // 第一页末
    expect(archiveCalls[200]).toBe('team-200'); // 第二页首
    expect(archiveCalls[299]).toBe('team-299');
  });
});
