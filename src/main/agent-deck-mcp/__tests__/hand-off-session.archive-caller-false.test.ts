/**
 * plan handoff-no-spawn-guards-20260526 §D5/§D6/§D7/§D8 收口测试 —
 * `resolveBatonRoleForSpawn` lambda + hand-off-session handler 集成 test。
 *
 * **故意推翻 REVIEW_46/47 修法**(本文件原为 Phase 1.3b deep-review-batch-a1-b-followup-r3-20260519
 * 的「验 REVIEW_46/47 修法」测试,plan §D5/§D6 故意推翻这两个修法 → 整文件反转):
 *
 * - 旧 REVIEW_46 B-HIGH-2: `archive_caller=false` 退化 normal spawn 走完整 spawn-guards;
 *   plan §D4 推翻 — `archive_caller=false` 也走 hand-off 路径(handOffMode=true)完全跳过
 *   三道防御,power-user 自负责任(§D3 + §D4)
 * - 旧 REVIEW_47 M12: `archive_caller=false` 时 batonRole=undefined 让 spawn 走默认 'teammate';
 *   plan §D5 推翻 — hand-off 两路径都用 batonRole='lead'(无 archive_caller 分流)
 *
 * **测试策略**(不变量 3:端到端断言真实生产代码):
 * - **lambda unit test**:直接 import `resolveBatonRoleForSpawn` 调真实 production lambda
 *   断言常量返回值 `{ handOffMode: true, batonRole: 'lead' }`(plan §D8 lambda 退化常量,
 *   入参签名简化为无参 + 无 archive_caller 分流)
 * - **handler 集成 test**:mock spawn handler 断言 `opts.handOffMode` / `opts.batonRole`
 *   真实传入值 = `{ handOffMode: true, batonRole: 'lead' }`,不论 archive_caller 值
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

describe('resolveBatonRoleForSpawn lambda (plan §D8 退化常量)', () => {
  it('无入参 → 返常量 { handOffMode: true, batonRole: "lead" } (§D5 + §D8)', () => {
    const result = resolveBatonRoleForSpawn();
    expect(result.handOffMode).toBe(true);
    expect(result.batonRole).toBe('lead');
  });

  it('每次调用返同款常量(idempotent invariant)', () => {
    const r1 = resolveBatonRoleForSpawn();
    const r2 = resolveBatonRoleForSpawn();
    expect(r1).toEqual(r2);
    expect(r1.handOffMode).toBe(true);
    expect(r1.batonRole).toBe('lead');
    expect(r2.handOffMode).toBe(true);
    expect(r2.batonRole).toBe('lead');
  });

  // plan §D5 推翻 REVIEW_47 M12 修法语义验证:hand-off 两路径(archive_caller true/false)都用
  // batonRole='lead',不再有 archive_caller=false → batonRole=undefined 分流
  it('§D5 推翻 REVIEW_47 M12: 无 archive_caller 分流 — lambda 不接受任何入参', () => {
    // TypeScript 静态校验:lambda 签名是 () => { handOffMode: true; batonRole: 'lead' }
    // 任意 inline arg 在 typecheck 阶段被 TS2554 拦下(Expected 0 arguments)。
    // 运行时本 case 单纯调无参版本验返值常量。
    const result = resolveBatonRoleForSpawn();
    expect(result.batonRole).toBe('lead'); // 不是 undefined(M12 推翻)
    expect(result.handOffMode).toBe(true); // 不是 false(B-HIGH-2 推翻)
  });
});

describe('handOffSessionHandler — hand-off 路径完全跳过 spawn-guards / 永不写 spawn-link (§D1/§D4/§D5/§D6 端到端)', () => {
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
        // 第三参显式声明让类型友好,plan §D6 改名 batonMode → handOffMode 后签名同步
        _opts?: { handOffMode?: boolean; batonRole?: 'lead' | 'teammate' },
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

  // 推翻 REVIEW_46 B-HIGH-2:archive_caller=false 不再退化 normal spawn,仍走 hand-off 路径
  it('archive_caller=false → spawn opts.handOffMode === true + opts.batonRole === lead (§D1/§D4 推翻 B-HIGH-2)', async () => {
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
      archive_caller: false, // ← 推翻 B-HIGH-2:archive_caller=false 不再退化 normal spawn
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

    // 核心断言:spawn handler 拿到的 opts.handOffMode === true(§D1/§D4 hand-off 路径完全跳 spawn-guards)
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const opts = mockSpawn.mock.calls[0]![2];
    expect(opts?.handOffMode).toBe(true);

    // §D5 推翻 M12:batonRole='lead'(不是 undefined),hand-off 两路径行为统一
    expect(opts?.batonRole).toBe('lead');

    sessionRepoGetSpy.mockRestore();
  });

  it('archive_caller=true 显式 → spawn opts.handOffMode === true + opts.batonRole === lead', async () => {
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
    expect(opts?.handOffMode).toBe(true);
    expect(opts?.batonRole).toBe('lead');

    sessionRepoGetSpy.mockRestore();
  });

  it('archive_caller 不传 (default) → spawn opts.handOffMode === true + opts.batonRole === lead', async () => {
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
      // archive_caller 不传 — default 走 hand-off 路径
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
    expect(opts?.handOffMode).toBe(true);
    expect(opts?.batonRole).toBe('lead');

    sessionRepoGetSpy.mockRestore();
  });

  // §D6 + §D7 守门:archive_caller=false + team_name 显式组合下也走 hand-off 路径(不被 team_name 反转)
  it('archive_caller=false + team_name 显式 → spawn opts 仍走 hand-off 路径 (§D6 守门)', async () => {
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

    // team_name 透传给 spawn args（独立于 handOffMode 决策）
    expect(spawnArgs.team_name).toBe('foo-team');

    // §D6 守门:archive_caller=false + team_name 仍走 hand-off 路径,不被 team_name 反转
    expect(opts?.handOffMode).toBe(true);
    expect(opts?.batonRole).toBe('lead');

    sessionRepoGetSpy.mockRestore();
  });
});
