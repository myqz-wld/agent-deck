/**
 * hand_off_session handler task ownership 过继测试
 * (plan task-team-id-restore-20260525 §Phase G4 大改造 — v024 三态 policy + skip 真删 + safeEmit + DB throw + preserve-team safety)。
 *
 * 验：handler 在 spawn 完成 + adopt 流程 (如有) 完成后、archive caller 之前
 * 调 reassignTaskOwner / applyHandOffSkipPolicy test seam 把 caller 拥有的所有 task 转给新 sid
 * （三态:clear-team / preserve-team / skip — plan §D4）。
 *
 * 测试不依赖 vi.mock + 不依赖真 SDK / DB — 走 handlerDeps test seam 全注入。
 *
 * **v024 三态行为契约**:
 * - 'clear-team' (default): reassignOwner({policy:'clear-team'}) + ok.taskReassignment.policy='clear-team'
 * - 'preserve-team': reassignOwner({policy:'preserve-team'}) + preserve-team safety
 *   (findCallerOwnedTeamIds vs phase15Detail.adoptedTeamIds 差集 → policyWarning + unadoptedTeamIds)
 * - 'skip': applyHandOffSkipPolicy 单 transaction 4 步 + per-id safeEmit task-changed deleted +
 *   DB throw fallback (status='failed' 不抛错给 caller)
 *
 * **archive_caller=false 优先级**: 三态都 skip,policy 字段透传 advisory (status='skipped')
 *
 * **policy field required (R6 MED-2)**: 所有 5 个 assignment 路径
 * (skip ok / skip failed / clear-team / preserve-team / archive_caller=false) 都带 policy
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { handOffSessionHandler } from '../tools/handlers/hand-off-session';
import type { HandOffSessionArgs, SpawnSessionArgs } from '../tools/schemas';
import type { HandlerContext, HandlerResult } from '../tools/helpers';
import { sessionRepo } from '@main/store/session-repo';
import { eventBus } from '@main/event-bus';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import type { AgentDeckTeam, AgentDeckTeamMember } from '@shared/types';
import { makeState, makeDeps, planContent } from './hand-off-session/_setup';

// 共享 noop shutdown teammates seam（防 helper 调真 agentDeckTeamRepo 撞 DB 未 init）
const noopShutdown = vi.fn(async (_callerSid: string) => ({
  closed: [],
  failed: [],
  skipped: 'caller-not-lead' as const,
}));

/** 共享 fake sessionRepo.get mock — caller-sid 返回固定 row */
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

/** mockSpawn 返回固定 sessionId='new-sid' 让 reassignFn 拿到稳定参数 */
function makeMockSpawn(newSid = 'new-sid') {
  return vi.fn(
    async (
      _args: SpawnSessionArgs,
      _ctx: HandlerContext,
      _opts?: { batonMode?: boolean; batonRole?: 'lead' | 'teammate' },
    ): Promise<HandlerResult> => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            sessionId: newSid,
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

function makeBaseArgs(planId: string): HandOffSessionArgs {
  return {
    plan_id: planId,
    adapter: 'claude-code',
  };
}

function makeBaseState(planId: string) {
  const state = makeState();
  const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
  const worktreePath = `/Users/test/repo/.claude/worktrees/${planId}`;
  state.files.set(
    planFilePath,
    planContent({ planId, status: 'in_progress', worktreePath, baseBranch: 'main' }),
  );
  return state;
}

const ctx: HandlerContext = {
  caller: { callerSessionId: 'caller-sid', transport: 'in-process' },
};

/** parse ok.taskReassignment from handler result */
function parseResult(result: HandlerResult): {
  taskReassignment: {
    status: 'ok' | 'skipped' | 'failed';
    policy?: 'clear-team' | 'preserve-team' | 'skip';
    count?: number;
    reason?: string;
    error?: string;
    policyWarning?: string;
    unadoptedTeamIds?: string[];
  };
  adopted: unknown;
} {
  return JSON.parse((result.content[0] as { text: string }).text);
}

describe('hand_off_session v024 / clear-team policy (default)', () => {
  it('不传 team_task_policy → 默认 clear-team；reassignOwner({policy:"clear-team"}) + ok.taskReassignment={status:ok, count:N, policy:"clear-team"}', async () => {
    const state = makeBaseState('task-reassign-default-clear');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const mockReassign = vi.fn(
      (_old: string, _new: string, _opts: { policy: 'clear-team' | 'preserve-team' }) => 3,
    );
    const sessionRepoGetSpy = spyCallerRow();

    const result = await handOffSessionHandler(makeBaseArgs('task-reassign-default-clear'), ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      shutdownTeammates: noopShutdown,
      reassignTaskOwner: mockReassign,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    expect(mockReassign).toHaveBeenCalledTimes(1);
    expect(mockReassign).toHaveBeenCalledWith('caller-sid', 'new-sid', { policy: 'clear-team' });

    const json = parseResult(result);
    expect(json.taskReassignment).toEqual({ status: 'ok', count: 3, policy: 'clear-team' });

    sessionRepoGetSpy.mockRestore();
  });

  it('显式 team_task_policy: "clear-team" → 同款行为 + policy 字段透传', async () => {
    const state = makeBaseState('task-reassign-explicit-clear');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockReassign = vi.fn((_old: string, _new: string, _opts) => 2);
    const sessionRepoGetSpy = spyCallerRow();

    const args: HandOffSessionArgs = {
      ...makeBaseArgs('task-reassign-explicit-clear'),
      team_task_policy: 'clear-team',
    };
    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: vi.fn(),
      shutdownTeammates: noopShutdown,
      reassignTaskOwner: mockReassign,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    expect(mockReassign).toHaveBeenCalledWith('caller-sid', 'new-sid', { policy: 'clear-team' });
    expect(parseResult(result).taskReassignment.policy).toBe('clear-team');
    sessionRepoGetSpy.mockRestore();
  });

  it('reassignFn 抛错 → fallback: status="failed" + error + policy="clear-team"', async () => {
    const state = makeBaseState('task-reassign-clear-throws');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockReassign = vi.fn((_old: string, _new: string, _opts) => {
      throw new Error('SQLite locked');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessionRepoGetSpy = spyCallerRow();

    const result = await handOffSessionHandler(makeBaseArgs('task-reassign-clear-throws'), ctx, {
      spawnSession: mockSpawn,
      archiveSession: vi.fn(),
      shutdownTeammates: noopShutdown,
      reassignTaskOwner: mockReassign,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy(); // ok return 不被阻塞
    expect(parseResult(result).taskReassignment).toEqual({
      status: 'failed',
      error: 'SQLite locked',
      policy: 'clear-team',
    });

    warnSpy.mockRestore();
    sessionRepoGetSpy.mockRestore();
  });
});

describe('hand_off_session v024 / preserve-team policy + safety 4 cases (Round 4 HIGH-1)', () => {
  it('case a: caller 有 team-B task + newSid 没接管 team-B → policyWarning="preserve-team-unadopted-teams" + unadoptedTeamIds=["team-B"]', async () => {
    // caller-as-teammate teams (not lead) → adopt fail reason='caller-not-lead-in-team'
    // findCallerOwnedTeamIds 返 ['team-B']（caller 拥有的 team-bound task 在 team-B）
    // phase15Detail.adoptedTeamIds=[]（adopt 没接管任何 team — 默认 adopt_teammates=false）
    // spawnData.teamId=null（mockSpawn 返 null）
    // → 差集 = ['team-B']
    const state = makeBaseState('preserve-team-case-a');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockReassign = vi.fn((_old: string, _new: string, _opts) => 1);
    const mockFindOwnedTeamIds = vi.fn((_sid: string) => ['team-B']);
    const sessionRepoGetSpy = spyCallerRow();

    const args: HandOffSessionArgs = {
      ...makeBaseArgs('preserve-team-case-a'),
      team_task_policy: 'preserve-team',
      // 不开 adopt_teammates → phase15Detail.adoptedTeamIds=[]
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: vi.fn(),
      shutdownTeammates: noopShutdown,
      reassignTaskOwner: mockReassign,
      findCallerOwnedTeamIds: mockFindOwnedTeamIds,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    expect(mockReassign).toHaveBeenCalledWith('caller-sid', 'new-sid', { policy: 'preserve-team' });
    expect(mockFindOwnedTeamIds).toHaveBeenCalledWith('caller-sid');

    const json = parseResult(result);
    expect(json.taskReassignment.status).toBe('ok');
    expect(json.taskReassignment.policy).toBe('preserve-team');
    expect(json.taskReassignment.policyWarning).toBe('preserve-team-unadopted-teams');
    expect(json.taskReassignment.unadoptedTeamIds).toEqual(['team-B']);

    sessionRepoGetSpy.mockRestore();
  });

  it('case b 锁住 firstTeam push 完整性: caller 仅有 team-X 的 task + adopt 通过 → policyWarning undefined（不能 false positive）', async () => {
    // 没 adopt_teammates → phase15Detail.adoptedTeamIds 仍 [] —— 但 caller 也没有 team task
    // findCallerOwnedTeamIds 返 []（caller 仅 personal）→ 差集 = [] → policyWarning undefined
    // (case b 实际锁住 case "caller 无 team task" 不会触发 warning)
    const state = makeBaseState('preserve-team-case-b-no-team-task');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockReassign = vi.fn((_old: string, _new: string, _opts) => 5); // 5 个 personal
    const mockFindOwnedTeamIds = vi.fn((_sid: string) => []); // caller 仅 personal
    const sessionRepoGetSpy = spyCallerRow();

    const args: HandOffSessionArgs = {
      ...makeBaseArgs('preserve-team-case-b-no-team-task'),
      team_task_policy: 'preserve-team',
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: vi.fn(),
      shutdownTeammates: noopShutdown,
      reassignTaskOwner: mockReassign,
      findCallerOwnedTeamIds: mockFindOwnedTeamIds,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    const json = parseResult(result);
    expect(json.taskReassignment.status).toBe('ok');
    expect(json.taskReassignment.policy).toBe('preserve-team');
    expect(json.taskReassignment.policyWarning).toBeUndefined();
    expect(json.taskReassignment.unadoptedTeamIds).toBeUndefined();

    sessionRepoGetSpy.mockRestore();
  });

  it('case c: caller 有 team-A task + 没 adopt_teammates → unadoptedTeamIds=["team-A"]', async () => {
    const state = makeBaseState('preserve-team-case-c');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockReassign = vi.fn((_old: string, _new: string, _opts) => 2);
    const mockFindOwnedTeamIds = vi.fn((_sid: string) => ['team-A']);
    const sessionRepoGetSpy = spyCallerRow();

    const args: HandOffSessionArgs = {
      ...makeBaseArgs('preserve-team-case-c'),
      team_task_policy: 'preserve-team',
      // 不开 adopt_teammates
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: vi.fn(),
      shutdownTeammates: noopShutdown,
      reassignTaskOwner: mockReassign,
      findCallerOwnedTeamIds: mockFindOwnedTeamIds,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    const json = parseResult(result);
    expect(json.taskReassignment.policyWarning).toBe('preserve-team-unadopted-teams');
    expect(json.taskReassignment.unadoptedTeamIds).toEqual(['team-A']);

    sessionRepoGetSpy.mockRestore();
  });

  it('findCallerOwnedTeamIds 抛错（safety query 失败）→ 仅 warn 不阻塞 reassign + policyWarning 退化 undefined', async () => {
    const state = makeBaseState('preserve-team-safety-throws');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockReassign = vi.fn((_old: string, _new: string, _opts) => 1);
    const mockFindOwnedTeamIds = vi.fn((_sid: string) => {
      throw new Error('DB unavailable');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessionRepoGetSpy = spyCallerRow();

    const args: HandOffSessionArgs = {
      ...makeBaseArgs('preserve-team-safety-throws'),
      team_task_policy: 'preserve-team',
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: vi.fn(),
      shutdownTeammates: noopShutdown,
      reassignTaskOwner: mockReassign,
      findCallerOwnedTeamIds: mockFindOwnedTeamIds,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    expect(mockReassign).toHaveBeenCalled(); // reassign 仍跑
    const json = parseResult(result);
    expect(json.taskReassignment.status).toBe('ok');
    expect(json.taskReassignment.policyWarning).toBeUndefined(); // safety 失败退化为不触发

    warnSpy.mockRestore();
    sessionRepoGetSpy.mockRestore();
  });
});

describe('hand_off_session v024 / skip policy 真删 (Round 2 MED-1 + Round 4 MED-2/3)', () => {
  it('skip 路径: applyHandOffSkipPolicy 被调 + per-id emit task-changed deleted × N + ok.taskReassignment={status:ok, count:N+P, policy:"skip"}', async () => {
    const state = makeBaseState('skip-policy-ok');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockApplySkip = vi.fn((_cs: string, _ns: string) => ({
      deletedTeamTaskIds: ['t-team-1', 't-team-2'],
      reassignedPersonalCount: 3,
    }));
    const emitSpy = vi.spyOn(eventBus, 'emit').mockImplementation(() => {});
    const sessionRepoGetSpy = spyCallerRow();

    const args: HandOffSessionArgs = {
      ...makeBaseArgs('skip-policy-ok'),
      team_task_policy: 'skip',
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: vi.fn(),
      shutdownTeammates: noopShutdown,
      applyHandOffSkipPolicy: mockApplySkip,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    expect(mockApplySkip).toHaveBeenCalledWith('caller-sid', 'new-sid');

    // emit task-changed deleted 每行 emit（per-id safeEmit）
    const taskDeletedEmits = emitSpy.mock.calls.filter(
      (c) => c[0] === 'task-changed' && (c[1] as { kind: string }).kind === 'deleted',
    );
    expect(taskDeletedEmits).toHaveLength(2);
    expect((taskDeletedEmits[0][1] as { taskId: string }).taskId).toBe('t-team-1');
    expect((taskDeletedEmits[1][1] as { taskId: string }).taskId).toBe('t-team-2');

    const json = parseResult(result);
    expect(json.taskReassignment).toEqual({
      status: 'ok',
      count: 5, // 2 deleted + 3 reassigned personal
      policy: 'skip',
    });

    emitSpy.mockRestore();
    sessionRepoGetSpy.mockRestore();
  });

  it('skip DB throw fallback: applyHandOffSkipPolicy throws → status="failed" + error + policy="skip"，不抛错给 caller', async () => {
    const state = makeBaseState('skip-db-throw');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockArchive = vi.fn(async () => undefined);
    const mockApplySkip = vi.fn((_cs: string, _ns: string) => {
      throw new Error('DB locked');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessionRepoGetSpy = spyCallerRow();

    const args: HandOffSessionArgs = {
      ...makeBaseArgs('skip-db-throw'),
      team_task_policy: 'skip',
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      shutdownTeammates: noopShutdown,
      applyHandOffSkipPolicy: mockApplySkip,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy(); // 不抛错给 caller（spawn/adopt 已成功不回滚）
    expect(mockArchive).toHaveBeenCalledTimes(1); // 仍走 archive caller
    const json = parseResult(result);
    expect(json.taskReassignment).toEqual({
      status: 'failed',
      error: 'DB locked',
      policy: 'skip',
    });

    warnSpy.mockRestore();
    sessionRepoGetSpy.mockRestore();
  });

  it('skip emit listener throw safeEmit fallback: listener throw → console.warn + 继续 emit 剩余 ids + status="ok"', async () => {
    const state = makeBaseState('skip-emit-listener-throws');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockApplySkip = vi.fn((_cs: string, _ns: string) => ({
      deletedTeamTaskIds: ['t-1', 't-2', 't-3'],
      reassignedPersonalCount: 0,
    }));
    // 第一个 emit throw,后面应继续
    let emitCallIdx = 0;
    const emitSpy = vi.spyOn(eventBus, 'emit').mockImplementation(((event: string, payload: { kind?: string }) => {
      if (event === 'task-changed' && payload.kind === 'deleted') {
        emitCallIdx += 1;
        if (emitCallIdx === 1) throw new Error('listener throws');
      }
    }) as never);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessionRepoGetSpy = spyCallerRow();

    const args: HandOffSessionArgs = {
      ...makeBaseArgs('skip-emit-listener-throws'),
      team_task_policy: 'skip',
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: vi.fn(),
      shutdownTeammates: noopShutdown,
      applyHandOffSkipPolicy: mockApplySkip,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    // 3 个 emit 都尝试调用（safeEmit per-id, listener throw 不中断）
    const taskDeletedAttempts = emitSpy.mock.calls.filter(
      (c) => c[0] === 'task-changed' && (c[1] as { kind: string }).kind === 'deleted',
    );
    expect(taskDeletedAttempts).toHaveLength(3);
    expect(warnSpy).toHaveBeenCalled();

    const json = parseResult(result);
    expect(json.taskReassignment.status).toBe('ok'); // emit failure 不影响 status
    expect(json.taskReassignment.count).toBe(3);
    expect(json.taskReassignment.policy).toBe('skip');

    warnSpy.mockRestore();
    emitSpy.mockRestore();
    sessionRepoGetSpy.mockRestore();
  });
});

describe('hand_off_session v024 / archive_caller=false × 三态 policy 都 skip + policy advisory 透传', () => {
  it('archive_caller=false + clear-team → skipped + reason="archive-caller-false" + policy="clear-team" advisory', async () => {
    const state = makeBaseState('skip-archive-clear');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockArchive = vi.fn(async () => undefined);
    const mockReassign = vi.fn();
    const mockApplySkip = vi.fn();
    const sessionRepoGetSpy = spyCallerRow();

    const args: HandOffSessionArgs = {
      ...makeBaseArgs('skip-archive-clear'),
      archive_caller: false,
      team_task_policy: 'clear-team',
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      shutdownTeammates: noopShutdown,
      reassignTaskOwner: mockReassign,
      applyHandOffSkipPolicy: mockApplySkip,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    expect(mockReassign).not.toHaveBeenCalled();
    expect(mockApplySkip).not.toHaveBeenCalled();
    expect(mockArchive).not.toHaveBeenCalled();
    expect(parseResult(result).taskReassignment).toEqual({
      status: 'skipped',
      reason: 'archive-caller-false',
      policy: 'clear-team',
    });

    sessionRepoGetSpy.mockRestore();
  });

  it('archive_caller=false + preserve-team → skipped + policy="preserve-team" advisory', async () => {
    const state = makeBaseState('skip-archive-preserve');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockReassign = vi.fn();
    const sessionRepoGetSpy = spyCallerRow();

    const args: HandOffSessionArgs = {
      ...makeBaseArgs('skip-archive-preserve'),
      archive_caller: false,
      team_task_policy: 'preserve-team',
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: vi.fn(),
      shutdownTeammates: noopShutdown,
      reassignTaskOwner: mockReassign,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    expect(mockReassign).not.toHaveBeenCalled();
    expect(parseResult(result).taskReassignment).toEqual({
      status: 'skipped',
      reason: 'archive-caller-false',
      policy: 'preserve-team',
    });

    sessionRepoGetSpy.mockRestore();
  });

  it('archive_caller=false + skip → skipped + policy="skip" advisory（不调 applyHandOffSkipPolicy）', async () => {
    const state = makeBaseState('skip-archive-skip');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockApplySkip = vi.fn();
    const sessionRepoGetSpy = spyCallerRow();

    const args: HandOffSessionArgs = {
      ...makeBaseArgs('skip-archive-skip'),
      archive_caller: false,
      team_task_policy: 'skip',
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: vi.fn(),
      shutdownTeammates: noopShutdown,
      applyHandOffSkipPolicy: mockApplySkip,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    expect(mockApplySkip).not.toHaveBeenCalled();
    expect(parseResult(result).taskReassignment).toEqual({
      status: 'skipped',
      reason: 'archive-caller-false',
      policy: 'skip',
    });

    sessionRepoGetSpy.mockRestore();
  });

  it('archive_caller=false 默认（不传 team_task_policy）→ skipped + policy="clear-team" advisory（默认 policy）', async () => {
    const state = makeBaseState('skip-archive-default-policy');
    const mockSpawn = makeMockSpawn('new-sid');
    const sessionRepoGetSpy = spyCallerRow();

    const args: HandOffSessionArgs = {
      ...makeBaseArgs('skip-archive-default-policy'),
      archive_caller: false,
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: vi.fn(),
      shutdownTeammates: noopShutdown,
      reassignTaskOwner: vi.fn(),
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    expect(parseResult(result).taskReassignment).toEqual({
      status: 'skipped',
      reason: 'archive-caller-false',
      policy: 'clear-team', // default policy advisory
    });

    sessionRepoGetSpy.mockRestore();
  });
});

describe('hand_off_session v024 / seam 默认值（reassignTaskOwner / applyHandOffSkipPolicy）', () => {
  it('不传 reassignTaskOwner seam → 走 taskRepo.reassignOwner default,无 DB init 抛错被 fallback → status="failed" + policy="clear-team"', async () => {
    // 真 taskRepo 在 vitest 无 DB init 状态下抛 "getDb is not a function" / 类似错。
    // 验：抛错被 try/catch warn 但 ok return 仍 success(与 mockReassign 抛错路径同款守门) +
    // taskReassignment 字段反映 failed 状态 + policy 字段透传。
    const state = makeBaseState('default-reassign-seam');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockArchive = vi.fn(async () => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessionRepoGetSpy = spyCallerRow();

    const result = await handOffSessionHandler(
      makeBaseArgs('default-reassign-seam'),
      ctx,
      {
        spawnSession: mockSpawn,
        archiveSession: mockArchive,
        shutdownTeammates: noopShutdown,
        // 不传 reassignTaskOwner → fallback 到 taskRepo.reassignOwner
        implDeps: makeDeps(state),
      },
    );

    expect(result.isError).toBeFalsy();
    const json = parseResult(result);
    expect(json.taskReassignment.status).toBe('failed');
    expect(json.taskReassignment.policy).toBe('clear-team');
    expect(typeof json.taskReassignment.error).toBe('string');

    warnSpy.mockRestore();
    sessionRepoGetSpy.mockRestore();
  });

  it('不传 applyHandOffSkipPolicy seam + team_task_policy="skip" → 走 taskRepo.applyHandOffSkipPolicy default,无 DB init 抛错 → status="failed" + policy="skip"', async () => {
    const state = makeBaseState('default-skip-seam');
    const mockSpawn = makeMockSpawn('new-sid');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessionRepoGetSpy = spyCallerRow();

    const args: HandOffSessionArgs = {
      ...makeBaseArgs('default-skip-seam'),
      team_task_policy: 'skip',
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: vi.fn(),
      shutdownTeammates: noopShutdown,
      // 不传 applyHandOffSkipPolicy → fallback 到 taskRepo.applyHandOffSkipPolicy
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    const json = parseResult(result);
    expect(json.taskReassignment.status).toBe('failed');
    expect(json.taskReassignment.policy).toBe('skip');
    expect(typeof json.taskReassignment.error).toBe('string');

    warnSpy.mockRestore();
    sessionRepoGetSpy.mockRestore();
  });
});

describe('hand_off_session v024 / 0 task 边界', () => {
  it('caller 没拥有任何 task（reassign 返 0）→ ok.taskReassignment={status:"ok", count:0, policy:"clear-team"}', async () => {
    const state = makeBaseState('task-reassign-empty');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockReassign = vi.fn((_old: string, _new: string, _opts) => 0);
    const sessionRepoGetSpy = spyCallerRow();

    const result = await handOffSessionHandler(makeBaseArgs('task-reassign-empty'), ctx, {
      spawnSession: mockSpawn,
      archiveSession: vi.fn(),
      shutdownTeammates: noopShutdown,
      reassignTaskOwner: mockReassign,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    expect(parseResult(result).taskReassignment).toEqual({
      status: 'ok',
      count: 0,
      policy: 'clear-team',
    });

    sessionRepoGetSpy.mockRestore();
  });
});

// ────────────────────────────────────────────────────────────────────
// Phase H Round 1 reviewer-codex MED-2 修法:补 preserve-team + adopt_teammates=true 真实
// adopt 路径覆盖 — case b 锁住 firstTeam push 完整性 + case d 锁住 firstTeam+rest 双 push +
// adopted.adoptedTeamIds surface 断言。
//
// **mock 模式**:vi.spyOn(agentDeckTeamRepo, 'findActiveMembershipsBySession') + 'get' + 'swapLead'
// 等触发 adopt 路径(adoptedSnapshot 内部装配依赖真 agentDeckTeamRepo,无 test seam);其他 seam
// 走 handlerDeps inject — 与 hand-off-session.adopt-teammates.test.ts 同款 pattern。
// ────────────────────────────────────────────────────────────────────

function fakeTeam(id: string, name: string): AgentDeckTeam {
  return {
    id,
    name,
    archivedAt: null,
    archiveReason: null,
    createdAt: 0,
    metadata: {},
  };
}

function fakeMember(opts: {
  teamId: string;
  sessionId: string;
  role: 'lead' | 'teammate';
  leftAt?: number | null;
}): AgentDeckTeamMember {
  return {
    teamId: opts.teamId,
    sessionId: opts.sessionId,
    role: opts.role,
    displayName: null,
    joinedAt: 1_000,
    leftAt: opts.leftAt ?? null,
  };
}

const okSwapLeadDefault = (
  _teamId: string,
  _oldSid: string,
  _newSid: string,
  _opts?: { newDisplayName?: string | null },
) => ({ swapped: true as const });

const activeLifecycleGetDefault = (sid: string) =>
  ({
    id: sid,
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
    cwdReleaseMarker: null,
  }) as never;

describe('hand_off_session v024 / preserve-team + adopt_teammates=true full surface (R1 codex MED-2 修法)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('case b (R4 HIGH-1 firstTeam push 完整性 锁住): caller lead-A + task team_id=A + preserve-team + adopt=true → swapLead 成功 → no policyWarning + adopted.adoptedTeamIds=["team-A"]', async () => {
    const state = makeBaseState('preserve-team-case-b-adopt');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockReassign = vi.fn((_old: string, _new: string, _opts) => 1);
    const mockFindOwnedTeamIds = vi.fn((_sid: string) => ['team-A']);

    // caller 在 team-A 是 lead (callerLeadTeamIds=['team-A'])
    vi.spyOn(agentDeckTeamRepo, 'findActiveMembershipsBySession').mockReturnValue([
      fakeMember({ teamId: 'team-A', sessionId: 'caller-sid', role: 'lead' }),
    ]);
    vi.spyOn(agentDeckTeamRepo, 'get').mockImplementation((tid: string) => {
      if (tid === 'team-A') return fakeTeam(tid, 'Team A');
      return null;
    });
    vi.spyOn(agentDeckTeamRepo, 'swapLead').mockImplementation(okSwapLeadDefault);
    vi.spyOn(agentDeckTeamRepo, 'listAllMembers').mockReturnValue([]);

    const sessionRepoGetSpy = spyCallerRow();

    const args: HandOffSessionArgs = {
      ...makeBaseArgs('preserve-team-case-b-adopt'),
      team_task_policy: 'preserve-team',
      adopt_teammates: true,
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: vi.fn(),
      shutdownTeammates: noopShutdown,
      reassignTaskOwner: mockReassign,
      findCallerOwnedTeamIds: mockFindOwnedTeamIds,
      // adopt 路径相关 seam（与 hand-off-session.adopt-teammates.test.ts 同款 default ok）
      swapLead: okSwapLeadDefault,
      getSessionForLifecycle: activeLifecycleGetDefault,
      listAllMembersForAdopt: (_teamId: string) => [],
      closeSession: vi.fn(async (_sid: string) => undefined),
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    const json = parseResult(result);
    expect(json.taskReassignment.status).toBe('ok');
    expect(json.taskReassignment.policy).toBe('preserve-team');
    // 关键 case b 锁住:firstTeam adopted 后 newSidActiveTeamIds 含 team-A → 与 caller owned team-A 无差集 → no warning
    expect(json.taskReassignment.policyWarning).toBeUndefined();
    expect(json.taskReassignment.unadoptedTeamIds).toBeUndefined();
    // 关键 R4 MED-1: adopted.adoptedTeamIds surface 顺序与 swap 序一致
    const adopted = json.adopted as { adoptedTeamIds?: string[] } | null;
    expect(adopted).not.toBeNull();
    expect(adopted?.adoptedTeamIds).toEqual(['team-A']);

    sessionRepoGetSpy.mockRestore();
  });

  it('case d (R4 HIGH-1 firstTeam+rest 双 push 完整性 锁住): caller lead-A+B + task A/B + preserve-team + adopt=true → swap 2 个都成功 → no policyWarning + adopted.adoptedTeamIds=["team-A","team-B"] 顺序', async () => {
    const state = makeBaseState('preserve-team-case-d-adopt');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockReassign = vi.fn((_old: string, _new: string, _opts) => 2);
    const mockFindOwnedTeamIds = vi.fn((_sid: string) => ['team-A', 'team-B']);

    // caller 在 team-A + team-B 都是 lead (callerLeadTeamIds=['team-A','team-B'])
    vi.spyOn(agentDeckTeamRepo, 'findActiveMembershipsBySession').mockReturnValue([
      fakeMember({ teamId: 'team-A', sessionId: 'caller-sid', role: 'lead' }),
      fakeMember({ teamId: 'team-B', sessionId: 'caller-sid', role: 'lead' }),
    ]);
    vi.spyOn(agentDeckTeamRepo, 'get').mockImplementation((tid: string) => {
      if (tid === 'team-A') return fakeTeam(tid, 'Team A');
      if (tid === 'team-B') return fakeTeam(tid, 'Team B');
      return null;
    });
    vi.spyOn(agentDeckTeamRepo, 'swapLead').mockImplementation(okSwapLeadDefault);
    vi.spyOn(agentDeckTeamRepo, 'listAllMembers').mockReturnValue([]);

    const sessionRepoGetSpy = spyCallerRow();

    const args: HandOffSessionArgs = {
      ...makeBaseArgs('preserve-team-case-d-adopt'),
      team_task_policy: 'preserve-team',
      adopt_teammates: true,
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: vi.fn(),
      shutdownTeammates: noopShutdown,
      reassignTaskOwner: mockReassign,
      findCallerOwnedTeamIds: mockFindOwnedTeamIds,
      swapLead: okSwapLeadDefault,
      getSessionForLifecycle: activeLifecycleGetDefault,
      listAllMembersForAdopt: (_teamId: string) => [],
      closeSession: vi.fn(async (_sid: string) => undefined),
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    const json = parseResult(result);
    expect(json.taskReassignment.status).toBe('ok');
    expect(json.taskReassignment.policy).toBe('preserve-team');
    // 关键 case d 锁住:firstTeam(team-A path L832) + rest loop(team-B path L862) 两处都 push → newSid
    // active teams = {team-A, team-B} = caller owned {team-A, team-B} → 差集为空 → no warning
    expect(json.taskReassignment.policyWarning).toBeUndefined();
    expect(json.taskReassignment.unadoptedTeamIds).toBeUndefined();
    // 关键 R4 HIGH-1: adoptedTeamIds 必须含 firstTeam (team-A) + rest (team-B) — 缺一处 implementer 漏改某 path 该 case 触发 false positive warning
    const adopted = json.adopted as { adoptedTeamIds?: string[] } | null;
    expect(adopted).not.toBeNull();
    expect(adopted?.adoptedTeamIds).toEqual(['team-A', 'team-B']); // 顺序与 swap 序一致

    sessionRepoGetSpy.mockRestore();
  });
});
