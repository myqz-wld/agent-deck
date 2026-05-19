/**
 * Phase 1.3b (plan deep-review-batch-a1-b-followup-r3-20260519)：
 * `resolveBatonRoleForSpawn` lambda + hand-off-session handler 集成 test。
 *
 * 覆盖两个 follow-up finding：
 *
 * **B-HIGH-2**（plan deep-review-batch-a1-b-fixes-20260519 / REVIEW_46）：旧 impl 无条件
 * `batonMode=true` 让 `archive_caller=false` 也跳 spawn-guards depth check + 不写 spawn-link
 * → caller 持 `archive_caller=false` × N 次调 hand_off 形成无限 spawn 路径绕过 fan-out=5/parent
 * + depth=3 双护栏。修法 = 条件化 `batonMode`：`archive_caller !== false` 时才跳 depth。
 *
 * **M12**（REVIEW_47 codex·B MED-4）：旧 impl 无条件 `batonRole='lead'`，即使
 * `archive_caller=false` 退化 normal spawn 也无脑传 'lead' 让 spawn.ts:408 addMember 分支拿到
 * 错误 role（如果同时有 team_name 启用 team 通信）。修法 = 条件化 batonRole：仅 `batonMode=true`
 * 真 baton 行为时传 'lead'，否则 undefined（让 spawn 走默认 'teammate'）。
 *
 * 测试策略（不变量 3：端到端断言真实生产代码）：
 * - **lambda unit test**：直接 import `resolveBatonRoleForSpawn` 调真实 production lambda 断言
 *   { batonMode, batonRole } 返回值，避免 inline 复制合约
 * - **handler 集成 test**：mock spawn handler 断言 `opts.batonMode` / `opts.batonRole` 真实传入值
 *   （hand-off-session.ts:345-356 调 lambda → spawn 路径完整覆盖）
 */
import { describe, expect, it, vi } from 'vitest';
import {
  handOffSessionHandler,
  resolveBatonRoleForSpawn,
} from '../tools/handlers/hand-off-session';
import type { HandOffSessionArgs, SpawnSessionArgs } from '../tools/schemas';
import type { HandlerContext, HandlerResult } from '../tools/helpers';
import { sessionRepo } from '@main/store/session-repo';
import { makeState, makeDeps, planContent } from './hand-off-session/_setup';

describe('resolveBatonRoleForSpawn lambda', () => {
  it('archive_caller undefined (default true 语义) → batonMode=true, batonRole=lead', () => {
    const result = resolveBatonRoleForSpawn({});
    expect(result.batonMode).toBe(true);
    expect(result.batonRole).toBe('lead');
  });

  it('archive_caller=true 显式 → batonMode=true, batonRole=lead', () => {
    const result = resolveBatonRoleForSpawn({ archive_caller: true });
    expect(result.batonMode).toBe(true);
    expect(result.batonRole).toBe('lead');
  });

  it('B-HIGH-2 + M12: archive_caller=false 退化 normal spawn → batonMode=false, batonRole=undefined', () => {
    const result = resolveBatonRoleForSpawn({ archive_caller: false });
    // B-HIGH-2: batonMode=false 让 spawn 走完整 depth/fan-out/setSpawnLink 与 spawn_session 同款
    expect(result.batonMode).toBe(false);
    // M12: batonRole=undefined 让 spawn 走默认 'teammate'（不传 'lead' 误标 normal spawn）
    expect(result.batonRole).toBeUndefined();
  });

  it('team_name 预留签名位不影响 batonRole 决策（仅 archive_caller 决定）', () => {
    // 带 team_name + archive_caller=true → 与不带 team_name 同结果
    const withTeam = resolveBatonRoleForSpawn({ archive_caller: true, team_name: 'foo-team' });
    const withoutTeam = resolveBatonRoleForSpawn({ archive_caller: true });
    expect(withTeam).toEqual(withoutTeam);
    expect(withTeam.batonMode).toBe(true);
    expect(withTeam.batonRole).toBe('lead');

    // 带 team_name + archive_caller=false → batonMode=false + batonRole=undefined
    // （即使 team_name 启用 team 通信，archive_caller=false 仍退化 normal spawn）
    const withTeamFalse = resolveBatonRoleForSpawn({ archive_caller: false, team_name: 'foo-team' });
    expect(withTeamFalse.batonMode).toBe(false);
    expect(withTeamFalse.batonRole).toBeUndefined();
  });
});

describe('handOffSessionHandler — archive_caller=false 退化 normal spawn (B-HIGH-2 + M12 端到端)', () => {
  // noop shutdownTeammates seam 防 helper 调真 agentDeckTeamRepo 撞 DB 未 init 噪音
  const noopShutdown = vi.fn(async (_callerSid: string) => ({
    closed: [],
    failed: [],
    skipped: 'caller-not-lead' as const,
  }));

  /** 共享 fake sessionRepo.get mock — caller-sid 返回固定 row（archive seam 探针需要） */
  function spyCallerRow() {
    return vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) => {
      if (id === 'caller-sid') {
        return {
          id: 'caller-sid',
          agentId: 'claude-code',
          cwd: '/Users/test/repo',
          title: 'fake',
          source: 'sdk',
          lifecycle: 'active',
          activity: 'idle',
          startedAt: 0,
          lastEventAt: 0,
          endedAt: null,
          archivedAt: null,
          spawnedBy: null,
          spawnDepth: 0,
        } as never;
      }
      return null;
    });
  }

  /** 共享 mockSpawn — 第三参 opts 被 vi.fn.mock.calls 自动记录 */
  function makeMockSpawn() {
    return vi.fn(
      async (
        _args: SpawnSessionArgs,
        _ctx: HandlerContext,
        // 第三参显式声明让类型友好，body 不消费但 mock.calls[i][2] 仍记录真实传入值
        _opts?: { batonMode?: boolean; batonRole?: 'lead' | 'teammate' },
      ): Promise<HandlerResult> => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              sessionId: 'fake-sid',
              adapter: 'claude-code',
              cwd: '/Users/test/repo',
              teamId: null,
              teamName: null,
              spawnDepth: 1,
              sentAt: 1234567890,
              spawnPromptMessageId: null,
            }),
          },
        ],
      }),
    );
  }

  it('archive_caller=false → spawn opts.batonMode === false + opts.batonRole 省略 (M12 omitUndefined)', async () => {
    const state = makeState();
    const planId = 'archive-caller-false-plan';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    const worktreePath = `/Users/test/repo/.claude/worktrees/${planId}`;
    state.files.set(
      planFilePath,
      planContent({ planId, status: 'in_progress', worktreePath, baseBranch: 'main' }),
    );

    const mockSpawn = makeMockSpawn();
    // hand-off-mcp-archive-opt-20260515: archive_caller=false 时 runBatonCleanup 跳 archive 段
    // (cleanup.archived='skipped')，但 mock archive seam 仍传防 helper 默认走真 sessionManager
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const sessionRepoGetSpy = spyCallerRow();

    const args: HandOffSessionArgs = {
      plan_id: planId,
      adapter: 'claude-code',
      archive_caller: false, // ← 核心 test 输入
    };
    const ctx: HandlerContext = {
      caller: { callerSessionId: 'caller-sid', transport: 'in-process' },
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      shutdownTeammates: noopShutdown,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();

    // 核心断言：spawn handler 拿到的 opts.batonMode === false（B-HIGH-2 修法）
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const opts = mockSpawn.mock.calls[0]![2];
    expect(opts?.batonMode).toBe(false);

    // M12 修法：batonRole 应被 omitUndefined 滤掉（不出现在 opts 对象），让 spawn 走默认 'teammate'
    // 不能用 expect(opts?.batonRole).toBeUndefined() — 那个对 `opts={batonMode:false}` 与
    // `opts={batonMode:false, batonRole: undefined}` 同样 pass。改用 'in' 操作符 narrow
    expect(opts && 'batonRole' in opts).toBe(false);

    sessionRepoGetSpy.mockRestore();
  });

  it('archive_caller=true 显式 → spawn opts.batonMode === true + opts.batonRole === lead', async () => {
    const state = makeState();
    const planId = 'archive-caller-true-plan';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    const worktreePath = `/Users/test/repo/.claude/worktrees/${planId}`;
    state.files.set(
      planFilePath,
      planContent({ planId, status: 'in_progress', worktreePath, baseBranch: 'main' }),
    );

    const mockSpawn = makeMockSpawn();
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const sessionRepoGetSpy = spyCallerRow();

    const args: HandOffSessionArgs = {
      plan_id: planId,
      adapter: 'claude-code',
      archive_caller: true, // ← 显式 true（与 undefined default 同语义）
    };
    const ctx: HandlerContext = {
      caller: { callerSessionId: 'caller-sid', transport: 'in-process' },
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      shutdownTeammates: noopShutdown,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const opts = mockSpawn.mock.calls[0]![2];
    expect(opts?.batonMode).toBe(true);
    expect(opts?.batonRole).toBe('lead');

    sessionRepoGetSpy.mockRestore();
  });

  it('archive_caller 不传 (default) → spawn opts.batonMode === true + opts.batonRole === lead', async () => {
    const state = makeState();
    const planId = 'archive-caller-default-plan';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    const worktreePath = `/Users/test/repo/.claude/worktrees/${planId}`;
    state.files.set(
      planFilePath,
      planContent({ planId, status: 'in_progress', worktreePath, baseBranch: 'main' }),
    );

    const mockSpawn = makeMockSpawn();
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const sessionRepoGetSpy = spyCallerRow();

    const args: HandOffSessionArgs = {
      plan_id: planId,
      adapter: 'claude-code',
      // archive_caller 不传 — default 走 baton 语义
    };
    const ctx: HandlerContext = {
      caller: { callerSessionId: 'caller-sid', transport: 'in-process' },
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      shutdownTeammates: noopShutdown,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const opts = mockSpawn.mock.calls[0]![2];
    expect(opts?.batonMode).toBe(true);
    expect(opts?.batonRole).toBe('lead');

    sessionRepoGetSpy.mockRestore();
  });

  it('archive_caller=false + team_name 显式 → spawn opts 仍走退化路径 (B-HIGH-2 不被 team_name 反转)', async () => {
    const state = makeState();
    const planId = 'archive-caller-false-with-team';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    const worktreePath = `/Users/test/repo/.claude/worktrees/${planId}`;
    state.files.set(
      planFilePath,
      planContent({ planId, status: 'in_progress', worktreePath, baseBranch: 'main' }),
    );

    const mockSpawn = makeMockSpawn();
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const sessionRepoGetSpy = spyCallerRow();

    const args: HandOffSessionArgs = {
      plan_id: planId,
      adapter: 'claude-code',
      archive_caller: false,
      team_name: 'foo-team', // ← caller 显式启用 team 通信
    };
    const ctx: HandlerContext = {
      caller: { callerSessionId: 'caller-sid', transport: 'in-process' },
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      shutdownTeammates: noopShutdown,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const spawnArgs = mockSpawn.mock.calls[0]![0];
    const opts = mockSpawn.mock.calls[0]![2];

    // team_name 透传给 spawn args（独立于 batonMode 决策）
    expect(spawnArgs.team_name).toBe('foo-team');

    // 但 archive_caller=false → batonMode/batonRole 仍走退化路径（M12 修法核心 — team_name 不反转决策）
    expect(opts?.batonMode).toBe(false);
    expect(opts && 'batonRole' in opts).toBe(false);

    sessionRepoGetSpy.mockRestore();
  });
});
