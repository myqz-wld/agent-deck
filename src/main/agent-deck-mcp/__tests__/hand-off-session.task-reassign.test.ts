/**
 * hand_off_session handler task ownership 过继测试
 * (plan task-mcp-owner-session-id-rewrite-20260521 v023 §D3)。
 *
 * 验：handler 在 spawn 完成 + adopt 流程 (如有) 完成后、archive caller 之前
 * 调 reassignTaskOwner test seam 把 caller 拥有的所有 task 转给新 sid。
 *
 * 失败策略：reassignTaskOwner 抛错时仅 warn 不阻塞 ok return (task 过继是
 * nice-to-have, hand_off baton 本质是 session 接力)。
 *
 * 测试不依赖 vi.mock + 不依赖真 SDK / DB — 走 handlerDeps test seam 全注入。
 */
import { describe, expect, it, vi } from 'vitest';
import { handOffSessionHandler } from '../tools/handlers/hand-off-session';
import type { HandOffSessionArgs, SpawnSessionArgs } from '../tools/schemas';
import type { HandlerContext, HandlerResult } from '../tools/helpers';
import { sessionRepo } from '@main/store/session-repo';
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

describe('hand_off_session — reassignTaskOwner (v023 §D3 + deep-review Round 1 F1+F3)', () => {
  it('成功路径(default archive_caller=true)：reassignTaskOwner(caller, newSid) + ok.taskReassignment={status:ok, count:3}', async () => {
    const state = makeBaseState('task-reassign-ok');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const mockReassign = vi.fn((_old: string, _new: string) => 3); // 模拟 3 条 task 被过继
    const sessionRepoGetSpy = spyCallerRow();

    const result = await handOffSessionHandler(makeBaseArgs('task-reassign-ok'), ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      shutdownTeammates: noopShutdown,
      reassignTaskOwner: mockReassign,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    expect(mockReassign).toHaveBeenCalledTimes(1);
    expect(mockReassign).toHaveBeenCalledWith('caller-sid', 'new-sid');

    // F3 修法：ok return 含 taskReassignment 字段(三态枚举)
    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json.taskReassignment).toEqual({ status: 'ok', count: 3 });

    sessionRepoGetSpy.mockRestore();
  });

  it('0 task 被过继(caller 没拥有 task)→ reassignFn 返 0，ok.taskReassignment={status:ok, count:0}', async () => {
    const state = makeBaseState('task-reassign-empty');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const mockReassign = vi.fn((_old: string, _new: string) => 0);
    const sessionRepoGetSpy = spyCallerRow();

    const result = await handOffSessionHandler(makeBaseArgs('task-reassign-empty'), ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      shutdownTeammates: noopShutdown,
      reassignTaskOwner: mockReassign,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    expect(mockReassign).toHaveBeenCalledTimes(1);
    expect(mockArchive).toHaveBeenCalledTimes(1); // 走完 archive caller

    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json.taskReassignment).toEqual({ status: 'ok', count: 0 });

    sessionRepoGetSpy.mockRestore();
  });

  it('F3 失败容错：reassignFn 抛错仅 warn 不阻塞 + ok.taskReassignment={status:failed, error}', async () => {
    const state = makeBaseState('task-reassign-throws');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const mockReassign = vi.fn((_old: string, _new: string) => {
      throw new Error('SQLite locked');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessionRepoGetSpy = spyCallerRow();

    const result = await handOffSessionHandler(makeBaseArgs('task-reassign-throws'), ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      shutdownTeammates: noopShutdown,
      reassignTaskOwner: mockReassign,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy(); // ok return 不被阻塞
    expect(mockReassign).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('task ownership reassign failed'),
      expect.any(Error),
    );
    expect(mockArchive).toHaveBeenCalledTimes(1); // 仍走 archive caller

    // F3 修法：caller 通过 ok return 看到失败原因(不再被 console.warn 静默吞)
    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json.taskReassignment).toEqual({
      status: 'failed',
      error: 'SQLite locked',
    });

    warnSpy.mockRestore();
    sessionRepoGetSpy.mockRestore();
  });

  it('seam 默认值：不传 reassignTaskOwner deps → 走 taskRepo.reassignOwner(生产路径)，抛错被兜底 + ok.taskReassignment={status:failed}', async () => {
    // 不传 reassignTaskOwner 时 default 路径走 taskRepo.reassignOwner。
    // 真 taskRepo 在 vitest 无 DB init 状态下抛 "getDb is not a function" / 类似错。
    // 验：抛错被 try/catch warn 但 ok return 仍 success(与 mockReassign 抛错路径同款守门) +
    // taskReassignment 字段反映 failed 状态。
    const state = makeBaseState('task-reassign-default-seam');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessionRepoGetSpy = spyCallerRow();

    const result = await handOffSessionHandler(
      makeBaseArgs('task-reassign-default-seam'),
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
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('task ownership reassign failed'),
      expect.any(Error),
    );

    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json.taskReassignment.status).toBe('failed');
    expect(typeof json.taskReassignment.error).toBe('string');

    warnSpy.mockRestore();
    sessionRepoGetSpy.mockRestore();
  });

  it('F1 (deep-review Round 1 双方独立)：archive_caller=false → 跳过 reassign + ok.taskReassignment={status:skipped, reason:"archive-caller-false"}', async () => {
    // F1 修法：archive_caller=false 路径表示 caller 仍 active 并行做事(default 无 team
    // 时 caller 与 newSid 无 shared team → 修前无条件过继让 caller 失去自己 task 写权限)。
    // 修后：仅 archive_caller!==false 时自动过继；archive_caller=false 跳过让 caller 继续
    // own 自己 task(走 isCallerAuthorizedToWrite caller==owner 特例)。
    const state = makeBaseState('task-reassign-no-archive');
    const mockSpawn = makeMockSpawn('new-sid');
    const mockArchive = vi.fn(async (_sid: string) => undefined);
    const mockReassign = vi.fn((_old: string, _new: string) => 2);
    const sessionRepoGetSpy = spyCallerRow();

    const args: HandOffSessionArgs = {
      ...makeBaseArgs('task-reassign-no-archive'),
      archive_caller: false, // caller 仍 active
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      shutdownTeammates: noopShutdown,
      reassignTaskOwner: mockReassign,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    // F1 修法核心：reassignFn 不被调用(caller 保留 task ownership)
    expect(mockReassign).not.toHaveBeenCalled();
    expect(mockArchive).not.toHaveBeenCalled(); // archive 同款跳过

    // F3：ok return.taskReassignment 反映 skipped + reason
    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json.taskReassignment).toEqual({
      status: 'skipped',
      reason: 'archive-caller-false',
    });

    sessionRepoGetSpy.mockRestore();
  });
});
