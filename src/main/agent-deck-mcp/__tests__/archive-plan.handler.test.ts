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
    workArgs: { plan_id: string; worktree_path: string; base_branch: string };
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
          'deadbeef123', // rev-parse HEAD
          '', // add
          '', // commit
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
        plan_id: input.planId,
        worktree_path: input.worktreePath,
        base_branch: input.baseBranch,
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
      { implDeps, archiveSession: mockArchive },
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
      { implDeps, archiveSession: mockArchive },
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
      { implDeps, archiveSession: mockArchive },
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
      { implDeps, archiveSession: mockArchive },
    );

    expect(result.isError).toBe(true); // impl dirty 检测 → 报错短路
    expect(mockArchive).not.toHaveBeenCalled();

    sessionRepoGetSpy.mockRestore();
  });
});
