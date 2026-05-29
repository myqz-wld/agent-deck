/**
 * archive_plan handler caller archive 三态单测（CHANGELOG_99 — CHANGELOG_105 拆分自 archive-plan.test.ts）。
 *
 * 范围：archivePlanHandler
 * - happy path:caller row 存在 → archive 成功 → archived=ok
 * - caller row 缺失 → archived=failed + console.warn,不阻塞 ok return
 * - archive 抛错 → archived=failed + console.warn,不阻塞 ok return
 *
 * 用 fixtureHappyPath 拼出能让 impl 真跑过 happy path 的 fixture（11 次 git 调用 + plan
 * 文件读 + writes + unlinks）,然后通过 handler 调用,验证 archive caller 三态。
 * vi.spyOn(sessionRepo, 'get') 而非 vi.mock,因 archive-plan handler 用 deps inject + sessionRepo
 * 真模块(无 hoisting 限制)。
 *
 * 其它范围 → archive-plan.impl-core.test.ts / archive-plan.impl-r33.test.ts
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { ArchivePlanDeps } from '../tools/handlers/archive-plan-impl';
import { makeDeps, fixtureHappyPath } from './archive-plan/_setup';

describe('archivePlanHandler — CHANGELOG_99 archive caller', () => {
  // CHANGELOG_106:noop shutdownTeammates seam,让本 describe 原 4 case 不撞 DB 未 init
  // (CHANGELOG_99 case 范围与 teammate shutdown 无关,但 handler 集成 helper 后默认走
  // 真 helper 会调 agentDeckTeamRepo 撞 DB)
  const noopShutdown = vi.fn(async (_callerSid: string) => ({
    closed: [],
    failed: [],
    skipped: 'caller-not-lead' as const,
  }));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T15:30:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // 用 fixtureHappyPath 拼出能让 impl 真跑过 happy path 的 fixture(11 次 git 调用 + plan
  // 文件读 + writes + unlinks)。然后通过 handler 调用,验证 archive caller 三态。
  // REVIEW_33 H1：在 ff-merge 前加了 rev-parse --verify <baseBranch> + checkout <baseBranch>
  // 共 2 次 git 调用 → 11 次（原 9 次）。
  function makeHandlerStub(implWillSucceed: boolean): {
    implDeps: ArchivePlanDeps;
    workArgs: { planId: string; worktreePath: string; baseBranch: string };
  } {
    const { state, input } = fixtureHappyPath();
    const gitStdouts = implWillSucceed
      ? [
          `${input.worktreePath.replace('/.claude/worktrees/' + input.planId, '')}/.git`, // git-common-dir
          'worktree-mcp-bug-fix-20260513', // abbrev-ref HEAD
          '', // status --porcelain (clean)
          'mainhash', // REVIEW_33 H1: rev-parse --verify <baseBranch>
          '', // REVIEW_33 H1: checkout <baseBranch>
          '', // merge --ff-only
          'deadbeef123', // rev-parse HEAD (finalCommit)
          '', // add
          '', // commit
          'archivehash', // rev-parse HEAD (archiveCommit, REVIEW_56 Batch B R1 MED-1)
          '', // worktree remove
          '', // branch -D
        ]
      : [
          `${input.worktreePath.replace('/.claude/worktrees/' + input.planId, '')}/.git`,
          'worktree-mcp-bug-fix-20260513',
          'M  some-file.ts', // status --porcelain (dirty) → impl 报错短路
        ];
    const deps = makeDeps(state, gitStdouts);
    return {
      implDeps: deps,
      workArgs: {
        planId: input.planId,
        worktreePath: input.worktreePath,
        baseBranch: input.baseBranch,
      },
    };
  }

  it('happy path:caller row 存在 → archive 成功 → archived=ok', async () => {
    const { archivePlanHandler } = await import('../tools/handlers/archive-plan');
    const { sessionRepo } = await import('@main/store/session-repo');

    const { implDeps, workArgs } = makeHandlerStub(true);
    const archiveCalls: string[] = [];
    const mockArchive = vi.fn(async (sid: string) => {
      archiveCalls.push(sid);
    });

    const sessionRepoGetSpy = vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) => {
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

    const result = await archivePlanHandler(
      workArgs,
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      // CHANGELOG_106:注入 noop shutdownTeammates 防默认 helper 撞 DB 未 init 噪音
      // (handler 兜底接住 warn,但 stderr 不干净;原 CHANGELOG_99 测试范围与 teammate
      // shutdown 无关,空 mock 即可让原断言不变)
      { implDeps, archiveSession: mockArchive, shutdownTeammates: noopShutdown },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.archived).toBe('ok');
    expect(archiveCalls).toEqual(['caller-sid']);

    sessionRepoGetSpy.mockRestore();
  });

  it('caller row 缺失 → archived=failed + console.warn,不阻塞 ok return', async () => {
    const { archivePlanHandler } = await import('../tools/handlers/archive-plan');
    const { sessionRepo } = await import('@main/store/session-repo');

    const { implDeps, workArgs } = makeHandlerStub(true);
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const sessionRepoGetSpy = vi.spyOn(sessionRepo, 'get').mockImplementation(() => null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await archivePlanHandler(
      workArgs,
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      // CHANGELOG_106:注入 noop shutdownTeammates 防默认 helper 撞 DB 未 init 噪音
      // (handler 兜底接住 warn,但 stderr 不干净;原 CHANGELOG_99 测试范围与 teammate
      // shutdown 无关,空 mock 即可让原断言不变)
      { implDeps, archiveSession: mockArchive, shutdownTeammates: noopShutdown },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.archived).toBe('failed');
    expect(mockArchive).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('cannot archive caller caller-sid: not in sessions table'),
    );

    sessionRepoGetSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('archive 抛错 → archived=failed + console.warn,不阻塞 ok return', async () => {
    const { archivePlanHandler } = await import('../tools/handlers/archive-plan');
    const { sessionRepo } = await import('@main/store/session-repo');

    const { implDeps, workArgs } = makeHandlerStub(true);
    const mockArchive = vi.fn(async (_sid: string) => {
      throw new Error('simulated archive error (FK constraint / DB locked)');
    });
    const sessionRepoGetSpy = vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) => {
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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await archivePlanHandler(
      workArgs,
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      // CHANGELOG_106:注入 noop shutdownTeammates 防默认 helper 撞 DB 未 init 噪音
      // (handler 兜底接住 warn,但 stderr 不干净;原 CHANGELOG_99 测试范围与 teammate
      // shutdown 无关,空 mock 即可让原断言不变)
      { implDeps, archiveSession: mockArchive, shutdownTeammates: noopShutdown },
    );

    // K2 同款:archive 抛错不阻塞,return ok + archived='failed'
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.archived).toBe('failed');
    expect(mockArchive).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('archive caller caller-sid failed:'),
      expect.any(Error),
    );

    sessionRepoGetSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('impl 失败短路(worktree dirty)→ 不调 archive caller(plan 收口本身没成功,语义上不该归档 caller)', async () => {
    const { archivePlanHandler } = await import('../tools/handlers/archive-plan');
    const { sessionRepo } = await import('@main/store/session-repo');

    const { implDeps, workArgs } = makeHandlerStub(false); // 让 impl 在 status 阶段报 dirty
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const sessionRepoGetSpy = vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) => {
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

    const result = await archivePlanHandler(
      workArgs,
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      // CHANGELOG_106:注入 noop shutdownTeammates 防默认 helper 撞 DB 未 init 噪音
      // (handler 兜底接住 warn,但 stderr 不干净;原 CHANGELOG_99 测试范围与 teammate
      // shutdown 无关,空 mock 即可让原断言不变)
      { implDeps, archiveSession: mockArchive, shutdownTeammates: noopShutdown },
    );

    expect(result.isError).toBe(true); // impl dirty 检测 → 报错短路
    expect(mockArchive).not.toHaveBeenCalled();

    sessionRepoGetSpy.mockRestore();
  });
});

// ─── CHANGELOG_106: shutdownTeammatesOnBaton 集成 ────────────────────────
//
// 范围:archivePlanHandler 调 shutdownTeammates helper 的行为 + ok return.teammatesShutdown 字段。
// 用 deps inject 的 shutdownTeammates seam mock 整个 helper 调用,不需要真碰 sessionManager.close
// / agentDeckTeamRepo。
//
// 覆盖(plan hand-off-session-adopt-teammates-20260520 Phase 3 删 baton-cleanup phase 1 opt-out 字段
// 后,旧 case 2 (phase 1 跳过 opt-out) 已废弃):
// 1. happy path: helper 返回 closed=[A,B] + skipped=null → ok.teammatesShutdown 透传
// 3. caller-not-lead: helper 返回 skipped='caller-not-lead' + closed=[] → 透传(caller 是 teammate)
// 4. helper 抛错: 兜底 skipped=null + closed=[] + warn,archive caller 仍走
// 5. impl 失败短路: 不调 helper(plan 收口没成功,不该牵连 teammate)
describe('archivePlanHandler — CHANGELOG_106 shutdownTeammatesOnBaton 集成', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-14T15:30:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // 与 CHANGELOG_99 段同款,wrapping fixture 让 impl 真跑过
  function makeHandlerStub(): {
    implDeps: ArchivePlanDeps;
    workArgs: { planId: string; worktreePath: string; baseBranch: string };
  } {
    const { state, input } = fixtureHappyPath();
    const gitStdouts = [
      `${input.worktreePath.replace('/.claude/worktrees/' + input.planId, '')}/.git`,
      'worktree-mcp-bug-fix-20260513',
      '',
      'mainhash',
      '',
      '',
      'deadbeef123',
      '',
      '',
      'archivehash',
      '',
      '',
    ];
    const deps = makeDeps(state, gitStdouts);
    return {
      implDeps: deps,
      workArgs: {
        planId: input.planId,
        worktreePath: input.worktreePath,
        baseBranch: input.baseBranch,
      },
    };
  }

  // helper:让 caller-sid 在 sessionRepo 表里有 row(让 archive caller 走 'ok' 路径不撞 row missing)
  async function spyCallerRow() {
    const { sessionRepo } = await import('@main/store/session-repo');
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

  it('happy path: helper 返回 closed=[A,B] → ok.teammatesShutdown 透传 + archive caller 仍调用', async () => {
    const { archivePlanHandler } = await import('../tools/handlers/archive-plan');
    const { implDeps, workArgs } = makeHandlerStub();
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const mockShutdown = vi.fn(async (_callerSid: string) => ({
      closed: ['teammate-A', 'teammate-B'],
      failed: [],
      skipped: null as null,
    }));
    const sessionRepoGetSpy = await spyCallerRow();

    const result = await archivePlanHandler(
      workArgs,
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      { implDeps, archiveSession: mockArchive, shutdownTeammates: mockShutdown },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    // teammatesShutdown 透传
    expect(data.teammatesShutdown).toEqual({
      closed: ['teammate-A', 'teammate-B'],
      failed: [],
      skipped: null,
    });
    // helper 用 caller sid 调用了一次
    expect(mockShutdown).toHaveBeenCalledTimes(1);
    // CHANGELOG_109(R37 P2-M Step 3.5): runBatonCleanup 内部统一双参签名传给 shutdownFn,
    // archive_plan 不传 excludeSessionIds 时第二参是 undefined(行为等价 — 旧 handler 单参调
    // shutdownTeammatesOnBaton 等价于新 helper 第二参 undefined)
    expect(mockShutdown).toHaveBeenCalledWith('caller-sid', undefined);
    // archive caller 也调了(独立动作不被 helper 影响)
    expect(mockArchive).toHaveBeenCalledTimes(1);
    expect(data.archived).toBe('ok');

    sessionRepoGetSpy.mockRestore();
  });

  it('caller-not-lead: helper 返回 caller-not-lead → 透传(caller 是 teammate 罕见 case)', async () => {
    const { archivePlanHandler } = await import('../tools/handlers/archive-plan');
    const { implDeps, workArgs } = makeHandlerStub();
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const mockShutdown = vi.fn(async (_sid: string) => ({
      closed: [],
      failed: [],
      skipped: 'caller-not-lead' as const,
    }));
    const sessionRepoGetSpy = await spyCallerRow();

    const result = await archivePlanHandler(
      workArgs,
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      { implDeps, archiveSession: mockArchive, shutdownTeammates: mockShutdown },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.teammatesShutdown.skipped).toBe('caller-not-lead');
    expect(data.teammatesShutdown.closed).toEqual([]);
    expect(mockShutdown).toHaveBeenCalledTimes(1);
    // caller 不是 lead 也不影响 archive caller(archive caller 与 baton 角色无关)
    expect(mockArchive).toHaveBeenCalledTimes(1);

    sessionRepoGetSpy.mockRestore();
  });

  it('helper 自身抛错 → 兜底 skipped=null + closed=[] + warn,archive caller 仍走', async () => {
    const { archivePlanHandler } = await import('../tools/handlers/archive-plan');
    const { implDeps, workArgs } = makeHandlerStub();
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const mockShutdown = vi.fn(async (_sid: string) => {
      throw new Error('simulated helper crash (DB exception / mock failure)');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sessionRepoGetSpy = await spyCallerRow();

    const result = await archivePlanHandler(
      workArgs,
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      { implDeps, archiveSession: mockArchive, shutdownTeammates: mockShutdown },
    );

    // 关键: ok return 不阻塞(plan 收口已成功不该被 helper 故障带崩)
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    // REVIEW_56 §F6 修法 (Plan-Review Round 2 codex MED-3): 兜底状态 closed=[] + failed=[] +
    // skipped='phase-1-error' 第五态 (原 null 与「正常无 teammate」混淆,改 'phase-1-error'
    // 显式区分 helper 真错 vs 正常路径)。
    expect(data.teammatesShutdown).toEqual({
      closed: [],
      failed: [],
      skipped: 'phase-1-error',
    });
    // archive caller 仍走(兜底关键: helper 故障不阻塞 archive)
    expect(mockArchive).toHaveBeenCalledTimes(1);
    expect(data.archived).toBe('ok');
    // warn 含 helper failed 提示
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('shutdownTeammatesOnBaton helper failed for caller caller-sid'),
      expect.any(Error),
    );

    sessionRepoGetSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('impl 失败短路(worktree dirty)→ 不调 helper(plan 收口没成功 baton 不该牵连 teammate)', async () => {
    const { archivePlanHandler } = await import('../tools/handlers/archive-plan');
    const { state, input } = fixtureHappyPath();
    const dirtyGitStdouts = [
      `${input.worktreePath.replace('/.claude/worktrees/' + input.planId, '')}/.git`,
      'worktree-mcp-bug-fix-20260513',
      'M  some-file.ts', // dirty 短路
    ];
    const dirtyDeps = makeDeps(state, dirtyGitStdouts);
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const mockShutdown = vi.fn(async (_sid: string) => ({
      closed: [],
      failed: [],
      skipped: null as null,
    }));
    const sessionRepoGetSpy = await spyCallerRow();

    const result = await archivePlanHandler(
      {
        planId: input.planId,
        worktreePath: input.worktreePath,
        baseBranch: input.baseBranch,
      },
      { caller: { callerSessionId: 'caller-sid', transport: 'in-process' } },
      { implDeps: dirtyDeps, archiveSession: mockArchive, shutdownTeammates: mockShutdown },
    );

    expect(result.isError).toBe(true); // impl 报错短路
    // 关键: helper / archive 都不被调用(plan 没收口成功)
    expect(mockShutdown).not.toHaveBeenCalled();
    expect(mockArchive).not.toHaveBeenCalled();

    sessionRepoGetSpy.mockRestore();
  });
});
