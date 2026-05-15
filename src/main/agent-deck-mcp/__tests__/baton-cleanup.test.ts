/**
 * baton-cleanup.ts 单测（CHANGELOG_109 R37 P2-M Step 3.5）。
 *
 * 范围：runBatonCleanup helper 的两阶段(teammate shutdown + archive caller)行为 + 三态分流 +
 * 失败容错。**不**走真 sessionRepo / sessionManager / shutdownTeammatesOnBaton —— 全 deps inject
 * mock(in-memory),保证测试快、零环境依赖、零副作用。
 *
 * helper 集成测试(handler 调 helper 的端到端)在 archive-plan.handler.test.ts /
 * hand-off-session.handler-deny-happy.test.ts 已覆盖。本文件专注 helper 自身行为。
 *
 * 覆盖矩阵:
 *
 * | case                                         | phase 1 (shutdown) | phase 2 (archive)             |
 * |----------------------------------------------|--------------------|-------------------------------|
 * | 1. external sentinel 短路                    | skipped='caller-not-lead' | 'skipped' (不调 getSession/archive) |
 * | 2. keep_teammates=true                       | skipped='keep-teammates' (不调 helper) | 'ok' (仍 archive caller) |
 * | 3. happy path                                | closed=[A,B] 透传 | 'ok'                          |
 * | 4. shutdown 透传 caller-not-lead             | skipped='caller-not-lead' 透传 | 'ok'                          |
 * | 5. shutdown 抛错                             | 兜底 + warn       | 'ok' (不阻塞)                 |
 * | 6. getSession 返回 null (row missing)        | closed=[A]        | 'failed' + warn (不调 archiveFn) |
 * | 7. getSession 抛错 (DB 异常 fail-safe)       | closed=[A]        | 'failed' + warn (走 row missing 路径) |
 * | 8. archiveFn 抛错                            | closed=[A]        | 'failed' + warn               |
 * | 9. excludeSessionIds 透传给 shutdown helper  | seam 收到 exclude 参数 | -                         |
 * | 10. 时序: shutdown 在 archive 之前           | call order 验证   | -                             |
 * | 11. archiveCaller=false → phase 2 跳过       | closed=[A]        | 'skipped' (不调 getFn/archiveFn)|
 * | 12. archiveCaller=false + keepTeammates=true | skipped='keep-teammates' (不调 helper) | 'skipped' (不调 getFn/archiveFn) |
 */

import { describe, it, expect, vi } from 'vitest';
import { runBatonCleanup } from '../tools/handlers/baton-cleanup';
import type { ShutdownTeammatesResult } from '../tools/handlers/shutdown-teammates-on-baton';

/** 构造一个 fake sessionRepo.get row(测试不在乎字段细节,只在乎 truthy/null) */
function fakeRow(id: string) {
  return {
    id,
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

describe('runBatonCleanup', () => {
  it('case 1: external sentinel 短路 → skipped=caller-not-lead + archived=skipped + 不调 deps', async () => {
    const shutdownFn = vi.fn(async (_sid: string) =>
      ({ closed: [], failed: [], skipped: null } as ShutdownTeammatesResult),
    );
    const archiveFn = vi.fn(async (_sid: string) => undefined);
    const getFn = vi.fn(() => fakeRow('whatever'));

    const result = await runBatonCleanup(
      {
        callerSessionId: '__external__',
        keepTeammates: false,
        toolName: 'archive_plan',
      },
      { shutdownTeammates: shutdownFn, archiveSession: archiveFn, getSession: getFn },
    );

    expect(result).toEqual({
      teammatesShutdown: { closed: [], failed: [], skipped: 'caller-not-lead' },
      archived: 'skipped',
    });
    // 关键:external sentinel 不调任何 deps(零副作用)
    expect(shutdownFn).not.toHaveBeenCalled();
    expect(archiveFn).not.toHaveBeenCalled();
    expect(getFn).not.toHaveBeenCalled();
  });

  it('case 2: keep_teammates=true → 跳过 shutdown helper + skipped=keep-teammates + archive 仍走', async () => {
    const shutdownFn = vi.fn(async (_sid: string) =>
      ({ closed: [], failed: [], skipped: null } as ShutdownTeammatesResult),
    );
    const archiveFn = vi.fn(async (_sid: string) => undefined);
    const getFn = vi.fn(() => fakeRow('caller'));

    const result = await runBatonCleanup(
      {
        callerSessionId: 'caller',
        keepTeammates: true,
        toolName: 'hand_off_session',
      },
      { shutdownTeammates: shutdownFn, archiveSession: archiveFn, getSession: getFn },
    );

    expect(result).toEqual({
      teammatesShutdown: { closed: [], failed: [], skipped: 'keep-teammates' },
      archived: 'ok',
    });
    // 关键: shutdown 完全不被调(caller 显式传 keep_teammates=true)
    expect(shutdownFn).not.toHaveBeenCalled();
    // archive 仍走(keep_teammates 与 archive caller 正交)
    expect(archiveFn).toHaveBeenCalledTimes(1);
    expect(archiveFn).toHaveBeenCalledWith('caller');
  });

  it('case 3: happy path → shutdown 返回 closed=[A,B] 透传 + archive ok', async () => {
    const shutdownFn = vi.fn(async (_sid: string) =>
      ({ closed: ['team-A', 'team-B'], failed: [], skipped: null } as ShutdownTeammatesResult),
    );
    const archiveFn = vi.fn(async (_sid: string) => undefined);
    const getFn = vi.fn(() => fakeRow('caller'));

    const result = await runBatonCleanup(
      {
        callerSessionId: 'caller',
        keepTeammates: false,
        toolName: 'archive_plan',
      },
      { shutdownTeammates: shutdownFn, archiveSession: archiveFn, getSession: getFn },
    );

    expect(result).toEqual({
      teammatesShutdown: { closed: ['team-A', 'team-B'], failed: [], skipped: null },
      archived: 'ok',
    });
    expect(shutdownFn).toHaveBeenCalledTimes(1);
    expect(archiveFn).toHaveBeenCalledTimes(1);
  });

  it('case 4: shutdown 透传 caller-not-lead(caller 是 teammate 罕见 case)+ archive 仍走', async () => {
    const shutdownFn = vi.fn(async (_sid: string) =>
      ({ closed: [], failed: [], skipped: 'caller-not-lead' } as ShutdownTeammatesResult),
    );
    const archiveFn = vi.fn(async (_sid: string) => undefined);
    const getFn = vi.fn(() => fakeRow('teammate-caller'));

    const result = await runBatonCleanup(
      {
        callerSessionId: 'teammate-caller',
        keepTeammates: false,
        toolName: 'hand_off_session',
      },
      { shutdownTeammates: shutdownFn, archiveSession: archiveFn, getSession: getFn },
    );

    expect(result.teammatesShutdown.skipped).toBe('caller-not-lead');
    expect(result.archived).toBe('ok');
  });

  it('case 5: shutdown 抛错 → 兜底 closed=[] + skipped=null + warn + archive 仍走', async () => {
    const shutdownFn = vi.fn(async (_sid: string) => {
      throw new Error('simulated DB exception in helper');
    });
    const archiveFn = vi.fn(async (_sid: string) => undefined);
    const getFn = vi.fn(() => fakeRow('caller'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runBatonCleanup(
      {
        callerSessionId: 'caller',
        keepTeammates: false,
        toolName: 'archive_plan',
      },
      { shutdownTeammates: shutdownFn, archiveSession: archiveFn, getSession: getFn },
    );

    expect(result.teammatesShutdown).toEqual({ closed: [], failed: [], skipped: null });
    // 关键: helper 故障不阻塞 archive caller(plan 收口已成功)
    expect(result.archived).toBe('ok');
    expect(archiveFn).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('shutdownTeammatesOnBaton helper failed for caller caller'),
      expect.any(Error),
    );
    // 验证 toolName 拼进 warn 前缀
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[mcp archive_plan]'),
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  it('case 6: getSession 返回 null (row missing) → archive=failed + warn + 不调 archiveFn', async () => {
    const shutdownFn = vi.fn(async (_sid: string) =>
      ({ closed: ['team-A'], failed: [], skipped: null } as ShutdownTeammatesResult),
    );
    const archiveFn = vi.fn(async (_sid: string) => undefined);
    const getFn = vi.fn(() => null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runBatonCleanup(
      {
        callerSessionId: 'ghost-caller',
        keepTeammates: false,
        toolName: 'hand_off_session',
      },
      { shutdownTeammates: shutdownFn, archiveSession: archiveFn, getSession: getFn },
    );

    // teammate 仍正常 close(phase 1 与 phase 2 独立)
    expect(result.teammatesShutdown.closed).toEqual(['team-A']);
    expect(result.archived).toBe('failed');
    // 关键: archive 不被调(探针 row 缺失 → short-circuit)
    expect(archiveFn).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('cannot archive caller ghost-caller: not in sessions table'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[mcp hand_off_session]'),
    );

    warnSpy.mockRestore();
  });

  it('case 7: getSession 抛错 (DB 异常 fail-safe) → 走 row missing 路径 archive=failed', async () => {
    const shutdownFn = vi.fn(async (_sid: string) =>
      ({ closed: ['team-A'], failed: [], skipped: null } as ShutdownTeammatesResult),
    );
    const archiveFn = vi.fn(async (_sid: string) => undefined);
    const getFn = vi.fn(() => {
      throw new Error('simulated SQLite locked');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runBatonCleanup(
      {
        callerSessionId: 'caller',
        keepTeammates: false,
        toolName: 'archive_plan',
      },
      { shutdownTeammates: shutdownFn, archiveSession: archiveFn, getSession: getFn },
    );

    // 关键: getSession 抛错 → catch 兜底为 null → 走 row missing 路径 'failed'
    expect(result.archived).toBe('failed');
    expect(archiveFn).not.toHaveBeenCalled();
    // teammate 段不受 phase 2 异常影响
    expect(result.teammatesShutdown.closed).toEqual(['team-A']);

    warnSpy.mockRestore();
  });

  it('case 8: archiveFn 抛错 → archive=failed + warn(与 row missing 同状态值不同来源)', async () => {
    const shutdownFn = vi.fn(async (_sid: string) =>
      ({ closed: ['team-A'], failed: [], skipped: null } as ShutdownTeammatesResult),
    );
    const archiveFn = vi.fn(async (_sid: string) => {
      throw new Error('simulated FK constraint violation');
    });
    const getFn = vi.fn(() => fakeRow('caller'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runBatonCleanup(
      {
        callerSessionId: 'caller',
        keepTeammates: false,
        toolName: 'archive_plan',
      },
      { shutdownTeammates: shutdownFn, archiveSession: archiveFn, getSession: getFn },
    );

    expect(result.archived).toBe('failed');
    expect(archiveFn).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('archive caller caller failed:'),
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  it('case 9: excludeSessionIds 透传给 shutdown helper(REVIEW_36 R2 HIGH-A)', async () => {
    const shutdownFn = vi.fn(
      async (_sid: string, _exclude?: ReadonlySet<string>) =>
        ({ closed: [], failed: [], skipped: null } as ShutdownTeammatesResult),
    );
    const archiveFn = vi.fn(async (_sid: string) => undefined);
    const getFn = vi.fn(() => fakeRow('caller'));

    const exclude = new Set<string>(['newly-spawned-sid']);
    await runBatonCleanup(
      {
        callerSessionId: 'caller',
        keepTeammates: false,
        excludeSessionIds: exclude,
        toolName: 'hand_off_session',
      },
      { shutdownTeammates: shutdownFn, archiveSession: archiveFn, getSession: getFn },
    );

    expect(shutdownFn).toHaveBeenCalledTimes(1);
    expect(shutdownFn).toHaveBeenCalledWith('caller', exclude);
  });

  it('case 10: 时序保证 — shutdown 在 archive 之前(callOrder 断言)', async () => {
    const order: string[] = [];
    const shutdownFn = vi.fn(async (_sid: string) => {
      order.push('shutdown');
      return { closed: [], failed: [], skipped: null } as ShutdownTeammatesResult;
    });
    const archiveFn = vi.fn(async (_sid: string) => {
      order.push('archive');
    });
    const getFn = vi.fn(() => {
      order.push('getSession');
      return fakeRow('caller');
    });

    await runBatonCleanup(
      {
        callerSessionId: 'caller',
        keepTeammates: false,
        toolName: 'archive_plan',
      },
      { shutdownTeammates: shutdownFn, archiveSession: archiveFn, getSession: getFn },
    );

    // 关键: shutdown 必须在 getSession + archive 之前(详 baton-cleanup.ts 顶部注释「时序保证」)
    expect(order).toEqual(['shutdown', 'getSession', 'archive']);
  });

  // hand-off-mcp-archive-opt-20260515: caller 显式传 archive_caller=false → phase 2 跳过 + archived='skipped'。
  // 与 case 1 external sentinel 同款 'skipped' 值,但来源不同(case 1 = 防御短路,本 case = 显式 caller 意图);
  // 关键差异:case 1 phase 1 也短路(skipped='caller-not-lead'),本 case phase 1 仍正常跑。
  it('case 11: archiveCaller=false → phase 2 跳过 + archived=skipped + 不调 getFn/archiveFn(phase 1 仍跑)', async () => {
    const shutdownFn = vi.fn(async (_sid: string) =>
      ({ closed: ['team-A'], failed: [], skipped: null } as ShutdownTeammatesResult),
    );
    const archiveFn = vi.fn(async (_sid: string) => undefined);
    const getFn = vi.fn(() => fakeRow('caller'));

    const result = await runBatonCleanup(
      {
        callerSessionId: 'caller',
        keepTeammates: false,
        archiveCaller: false,
        toolName: 'hand_off_session',
      },
      { shutdownTeammates: shutdownFn, archiveSession: archiveFn, getSession: getFn },
    );

    expect(result).toEqual({
      teammatesShutdown: { closed: ['team-A'], failed: [], skipped: null },
      archived: 'skipped',
    });
    // phase 1 仍正常跑(archive_caller 与 keep_teammates 字段正交)
    expect(shutdownFn).toHaveBeenCalledTimes(1);
    // 关键:phase 2 完全短路 — getFn / archiveFn 都不调
    expect(getFn).not.toHaveBeenCalled();
    expect(archiveFn).not.toHaveBeenCalled();
  });

  // hand-off-mcp-archive-opt-20260515: 两 opt-out 字段正交可同时启用 — caller 想起新 session 并行做事
  // (archive_caller=false) + 保留 reviewer 给 follow-up(keep_teammates=true)。
  it('case 12: archiveCaller=false + keepTeammates=true → phase 1 + phase 2 都跳过(两字段正交可同时 opt-out)', async () => {
    const shutdownFn = vi.fn(async (_sid: string) =>
      ({ closed: ['team-A'], failed: [], skipped: null } as ShutdownTeammatesResult),
    );
    const archiveFn = vi.fn(async (_sid: string) => undefined);
    const getFn = vi.fn(() => fakeRow('caller'));

    const result = await runBatonCleanup(
      {
        callerSessionId: 'caller',
        keepTeammates: true,
        archiveCaller: false,
        toolName: 'hand_off_session',
      },
      { shutdownTeammates: shutdownFn, archiveSession: archiveFn, getSession: getFn },
    );

    expect(result).toEqual({
      teammatesShutdown: { closed: [], failed: [], skipped: 'keep-teammates' },
      archived: 'skipped',
    });
    // 关键:两 opt-out 字段都被尊重 — 全 0 调用
    expect(shutdownFn).not.toHaveBeenCalled();
    expect(getFn).not.toHaveBeenCalled();
    expect(archiveFn).not.toHaveBeenCalled();
  });
});
