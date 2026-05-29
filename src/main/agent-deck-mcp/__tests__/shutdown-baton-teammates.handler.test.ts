/**
 * shutdown_baton_teammates handler 单测（plan deep-review-batch-a1-b-followup-r3-20260519
 * §Phase 5.3d）。
 *
 * 覆盖（plan §F1c R2 codex MED-4 错误契约）:
 * 1. external sentinel + transport=stdio → deny external（withMcpGuard 拦截）
 * 2. caller-not-lead → error + hint（非 silent success — escape hatch 是 caller 显式请求 cleanup,
 *    no-op 误导 caller 以为成功）
 * 3. happy path: caller is lead → mock helper 返 closed=[A,B] → ok return 透传
 * 4. helper 自身抛错 → error + console.warn + hint（与 archive_plan / hand_off_session
 *    runBatonCleanup 兜底 warn 不阻塞行为不同 — 本 tool 是 escape hatch,helper 失败就是「补跑
 *    没成功」需让 caller 显式知道）
 * 5. planId 透传 — ok return 含 args.planId
 *
 * 用 deps inject 模式 mock shutdownTeammates seam。不依赖真 sessionManager / agentDeckTeamRepo。
 */
import { describe, expect, it, vi } from 'vitest';
import { shutdownBatonTeammatesHandler } from '../tools/handlers/shutdown-baton-teammates';
import type { ShutdownBatonTeammatesArgs } from '../tools/schemas';
import type { HandlerContext } from '../tools/helpers';
import type { ShutdownTeammatesResult } from '../tools/handlers/shutdown-teammates-on-baton';

describe('shutdownBatonTeammatesHandler — deny external caller', () => {
  it('callerSessionId = __external__ + transport=stdio → 拒绝（withMcpGuard 拦截）', async () => {
    const args: ShutdownBatonTeammatesArgs = {};
    const ctx: HandlerContext = {
      caller: {
        callerSessionId: '__external__',
        transport: 'stdio',
      },
    };

    const result = await shutdownBatonTeammatesHandler(args, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not allowed for external caller');
  });

  it('callerSessionId = __external__ + transport=in-process → 拒绝（双保险）', async () => {
    // in-process closure override 应该把 caller 改成真 sid，不会到这里 sentinel；但本 case
    // 模拟 closure 没设置 / 异常分支 — 仍要 deny external（types.ts EXTERNAL_CALLER_ALLOWED
    // 表语义：sentinel 即 deny，与 transport 无关）
    const args: ShutdownBatonTeammatesArgs = {};
    const ctx: HandlerContext = {
      caller: {
        callerSessionId: '__external__',
        transport: 'in-process',
      },
    };

    const result = await shutdownBatonTeammatesHandler(args, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not allowed for external caller');
  });
});

describe('shutdownBatonTeammatesHandler — caller-not-lead error 契约', () => {
  it('R2 codex MED-4: helper 返回 caller-not-lead → error + hint（非 silent success）', async () => {
    const mockShutdown = vi.fn(
      async (_callerSid: string): Promise<ShutdownTeammatesResult> => ({
        closed: [],
        failed: [],
        skipped: 'caller-not-lead',
      }),
    );

    const args: ShutdownBatonTeammatesArgs = { planId: 'some-plan' };
    const ctx: HandlerContext = {
      caller: {
        callerSessionId: 'caller-sid',
        transport: 'in-process',
      },
    };

    const result = await shutdownBatonTeammatesHandler(args, ctx, {
      shutdownTeammates: mockShutdown,
    });

    // 关键: 转 error,不是 ok return 含 skipped='caller-not-lead'(silent success 误导 caller)
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error).toContain('caller-sid');
    expect(payload.error).toContain('not a lead in any active team');
    // hint 指向 IPC TeamShutdownAllTeammates / UI Team 面板备选路径
    expect(payload.hint).toContain('TeamShutdownAllTeammates');
    expect(payload.hint).toContain('UI Team panel');

    // helper 仍被调一次（不是 handler 端预先判定 caller 角色,而是 helper 内部 findMemberships 结果）
    expect(mockShutdown).toHaveBeenCalledTimes(1);
    expect(mockShutdown).toHaveBeenCalledWith('caller-sid');
  });
});

describe('shutdownBatonTeammatesHandler — happy path', () => {
  it('caller is lead → ok return 透传 closed/failed + skipped=null + planId', async () => {
    const mockShutdown = vi.fn(
      async (_callerSid: string): Promise<ShutdownTeammatesResult> => ({
        closed: ['teammate-A', 'teammate-B'],
        failed: [],
        skipped: null,
      }),
    );

    const args: ShutdownBatonTeammatesArgs = {
      planId: 'deep-review-batch-a1-b-followup-r3-20260519',
    };
    const ctx: HandlerContext = {
      caller: {
        callerSessionId: 'lead-sid',
        transport: 'in-process',
      },
    };

    const result = await shutdownBatonTeammatesHandler(args, ctx, {
      shutdownTeammates: mockShutdown,
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    expect(data).toEqual({
      closed: ['teammate-A', 'teammate-B'],
      failed: [],
      skipped: null,
      planId: 'deep-review-batch-a1-b-followup-r3-20260519',
    });
    expect(mockShutdown).toHaveBeenCalledTimes(1);
    expect(mockShutdown).toHaveBeenCalledWith('lead-sid');
  });

  it('caller is lead + 部分 close 失败 → ok return 透传 failed[] + closed[]（warn 不阻塞）', async () => {
    const mockShutdown = vi.fn(
      async (_callerSid: string): Promise<ShutdownTeammatesResult> => ({
        closed: ['teammate-ok'],
        failed: [
          { sessionId: 'teammate-fail', reason: 'simulated FK constraint' },
        ],
        skipped: null,
      }),
    );

    const args: ShutdownBatonTeammatesArgs = {};
    const ctx: HandlerContext = {
      caller: {
        callerSessionId: 'lead-sid',
        transport: 'in-process',
      },
    };

    const result = await shutdownBatonTeammatesHandler(args, ctx, {
      shutdownTeammates: mockShutdown,
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.closed).toEqual(['teammate-ok']);
    expect(data.failed).toEqual([
      { sessionId: 'teammate-fail', reason: 'simulated FK constraint' },
    ]);
    expect(data.skipped).toBeNull();
    expect(data.planId).toBeNull(); // args.planId 不传 → null
  });
});

describe('shutdownBatonTeammatesHandler — helper 抛错 → error + warn', () => {
  it('helper 自身抛错 → error + console.warn（escape hatch 不静默吞错）', async () => {
    const mockShutdown = vi.fn(async (_callerSid: string): Promise<ShutdownTeammatesResult> => {
      throw new Error('simulated agentDeckTeamRepo SQLite locked');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const args: ShutdownBatonTeammatesArgs = {
      planId: 'some-plan',
    };
    const ctx: HandlerContext = {
      caller: {
        callerSessionId: 'lead-sid',
        transport: 'in-process',
      },
    };

    const result = await shutdownBatonTeammatesHandler(args, ctx, {
      shutdownTeammates: mockShutdown,
    });

    // 关键: 转 error 不是 ok return（与 archive_plan / hand_off_session 兜底 warn 不阻塞行为
    // 不同 — 本 tool 是 escape hatch helper 失败 == 补跑没成功）
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error).toContain('shutdownTeammatesOnBaton helper failed');
    expect(payload.error).toContain('simulated agentDeckTeamRepo SQLite locked');
    expect(payload.hint).toContain('Internal helper error');
    expect(payload.hint).toContain('planId=some-plan');

    // warn 含 planId 前缀方便排查
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('shutdownTeammatesOnBaton helper threw'),
      expect.any(Error),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('planId=some-plan'),
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });
});
