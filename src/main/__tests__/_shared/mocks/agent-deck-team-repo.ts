/**
 * 测试用 agentDeckTeamRepo mock factory（R37 P2-F Step 3.1）。
 *
 * 抽自 `src/main/session/__tests__/manager-test-setup.ts` 的 `makeAgentDeckTeamRepoMock`，
 * 让 8 个 test 文件复用 — 之前每个文件 inline 写自己的 stateful stub（manager 系列只用 no-op /
 * universal-message-watcher / team-lifecycle-scheduler / team-coordinator / mcp tools 各自 stateful）。
 *
 * Factory 默认所有 18 个 method 是 no-op stub（返 null / 空数组 / 空 Map / 0），让 manager
 * 系列 archive / unarchive / reactivate / delete / ingest 主路径 test 走通（不验证 team 联动逻辑）。
 *
 * **stateful test override 模式**：
 * caller 可通过 `overrides` 注入自己的 stateful 行为（如 universal-message-watcher 的 `findActiveMembershipsBySession`
 * 闭包读外部 fixture）。Factory 接口面与真 AgentDeckTeamRepo 100% 对齐 — 真 repo 加 method
 * 编译期强制提示。
 */

import { vi } from 'vitest';
import type { AgentDeckTeamRepo } from '@main/store/agent-deck-team-repo';

export interface AgentDeckTeamRepoMockOptions {
  /** 部分覆盖 default method 实现（spy / 自定 stateful 行为） */
  overrides?: Partial<AgentDeckTeamRepo>;
}

export function makeAgentDeckTeamRepoMock(
  opts: AgentDeckTeamRepoMockOptions = {},
): AgentDeckTeamRepo {
  const base: AgentDeckTeamRepo = {
    // ─── team CRUD ───
    create: () => ({}) as ReturnType<AgentDeckTeamRepo['create']>,
    ensureByName: () => ({}) as ReturnType<AgentDeckTeamRepo['ensureByName']>,
    get: () => null,
    getByActiveName: () => null,
    getWithMembers: () => null,
    list: () => [],
    archive: () => null,
    unarchive: () => null,
    hardDelete: () => false,
    // ─── member CRUD ───
    addMember: vi.fn(() => ({}) as ReturnType<AgentDeckTeamRepo['addMember']>),
    leaveTeam: () => null,
    listActiveMembers: () => [],
    listAllMembers: () => [],
    findActiveMembershipIn: () => null,
    findActiveMembershipsBySession: () => [],
    findActiveTeamMembershipsBySession: () => [],
    findActiveMembershipsBySessionIds: () => new Map(),
    findSharedActiveTeams: () => [],
    countActiveLeads: () => 0,
    setRole: () => null,
    // plan hand-off-session-adopt-teammates-20260520 Phase 5: swapLead 默认 stub 返
    // swapped:false reason='mocked-no-op'(让单测必须显式 override 才模拟成功 — 防默认
    // success 漏测)
    swapLead: () => ({ swapped: false, reason: 'mocked-no-op' }) as ReturnType<AgentDeckTeamRepo['swapLead']>,
  };

  return { ...base, ...(opts.overrides ?? {}) };
}
