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
 * | case                                         | phase 1 (shutdown) | phase 2 (archive)             | emit 上抛 |
 * |----------------------------------------------|--------------------|-------------------------------|-----------|
 * | 1. external sentinel 短路                    | skipped='caller-not-lead' | 'skipped' (不调 getSession/archive) | not called |
 * | 2. keep_teammates=true                       | skipped='keep-teammates' (不调 helper) | 'ok' (仍 archive caller) | not called |
 * | 3. happy path                                | closed=[A,B] 透传 | 'ok'                          | not called |
 * | 4. shutdown 透传 caller-not-lead             | skipped='caller-not-lead' 透传 | 'ok'                          | not called |
 * | 5. shutdown 抛错                             | 兜底 + warn       | 'ok' (不阻塞)                 | not called |
 * | 6. getSession 返回 null (row missing)        | closed=[A]        | 'failed' + warn (不调 archiveFn) | reasonKind='row-missing' |
 * | 7. getSession 抛错 (DB 异常)                 | closed=[A]        | 'failed' + warn (不调 archiveFn) | reasonKind='probe-throw' (archive-toctou-fix-20260515) |
 * | 8. archiveFn 抛 generic Error                | closed=[A]        | 'failed' + warn               | reasonKind='archive-throw' |
 * | 8b. archiveFn 抛 SessionRowMissingError      | closed=[A]        | 'failed' + warn (race window) | reasonKind='row-missing' (archive-toctou-fix-20260515 instanceof 判别) |
 * | 9. excludeSessionIds 透传给 shutdown helper  | seam 收到 exclude 参数 | -                         | not called(archive ok)|
 * | 10. 时序: shutdown 在 archive 之前           | call order 验证   | -                             | not called(archive ok)|
 * | 11. archiveCaller=false → phase 2 跳过       | closed=[A]        | 'skipped' (不调 getFn/archiveFn)| -         |
 * | 12. archiveCaller=false + keepTeammates=true | skipped='keep-teammates' (不调 helper) | 'skipped' (不调 getFn/archiveFn) | -         |
 *
 * archive-failure-ux-upthrow-20260515 plan: case 6/7/8 加 emit 断言验证 'caller-archive-failed'
 * payload schema(sessionId / toolName / reason / reasonKind);case 1/3 加 not.toHaveBeenCalled
 * 守门「成功路径不误上抛」。
 *
 * archive-toctou-fix-20260515 plan: case 7 改 'probe-throw' (DB 异常独立 reasonKind 不再误归
 * row-missing — LOW probe-throw bug);新增 case 8b 验证 archiveFn 抛 SessionRowMissingError 时
 * instanceof 判别准确归 reasonKind='row-missing' (race window 修法 R1 reviewer-codex MED-1)。
 */

import { describe, it, expect, vi } from 'vitest';
import { runBatonCleanup } from '../tools/handlers/baton-cleanup';
import type { ShutdownTeammatesResult } from '../tools/handlers/shutdown-teammates-on-baton';
import { SessionRowMissingError } from '@main/store/session-repo';

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
    const emitFn = vi.fn();

    const result = await runBatonCleanup(
      {
        callerSessionId: '__external__',
        keepTeammates: false,
        toolName: 'archive_plan',
      },
      { shutdownTeammates: shutdownFn, archiveSession: archiveFn, getSession: getFn, emitArchiveFailed: emitFn },
    );

    expect(result).toEqual({
      teammatesShutdown: { closed: [], failed: [], skipped: 'caller-not-lead' },
      archived: 'skipped',
    });
    // 关键:external sentinel 不调任何 deps(零副作用)
    expect(shutdownFn).not.toHaveBeenCalled();
    expect(archiveFn).not.toHaveBeenCalled();
    expect(getFn).not.toHaveBeenCalled();
    // 短路返回 archived='skipped' 不是 'failed' → 不上抛 caller-archive-failed
    expect(emitFn).not.toHaveBeenCalled();
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
    const emitFn = vi.fn();

    const result = await runBatonCleanup(
      {
        callerSessionId: 'caller',
        keepTeammates: false,
        toolName: 'archive_plan',
      },
      { shutdownTeammates: shutdownFn, archiveSession: archiveFn, getSession: getFn, emitArchiveFailed: emitFn },
    );

    expect(result).toEqual({
      teammatesShutdown: { closed: ['team-A', 'team-B'], failed: [], skipped: null },
      archived: 'ok',
    });
    expect(shutdownFn).toHaveBeenCalledTimes(1);
    expect(archiveFn).toHaveBeenCalledTimes(1);
    // 关键: archive ok 不上抛 caller-archive-failed (避免 happy path 误打扰)
    expect(emitFn).not.toHaveBeenCalled();
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

  it('case 6: getSession 返回 null (row missing) → archive=failed + warn + 不调 archiveFn + emit row-missing', async () => {
    const shutdownFn = vi.fn(async (_sid: string) =>
      ({ closed: ['team-A'], failed: [], skipped: null } as ShutdownTeammatesResult),
    );
    const archiveFn = vi.fn(async (_sid: string) => undefined);
    const getFn = vi.fn(() => null);
    const emitFn = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runBatonCleanup(
      {
        callerSessionId: 'ghost-caller',
        keepTeammates: false,
        toolName: 'hand_off_session',
      },
      { shutdownTeammates: shutdownFn, archiveSession: archiveFn, getSession: getFn, emitArchiveFailed: emitFn },
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
    // archive-failure-ux-upthrow-20260515 plan: 上抛 row-missing 让 main bootstrap 桥接 notifyUser
    expect(emitFn).toHaveBeenCalledTimes(1);
    expect(emitFn).toHaveBeenCalledWith({
      sessionId: 'ghost-caller',
      toolName: 'hand_off_session',
      reason: expect.stringContaining('cannot archive caller ghost-caller: not in sessions table'),
      reasonKind: 'row-missing',
    });

    warnSpy.mockRestore();
  });

  it('case 7: getSession 抛错 (DB 异常) → 走 probe-throw 路径 archive=failed + emit probe-throw (archive-toctou-fix-20260515)', async () => {
    const shutdownFn = vi.fn(async (_sid: string) =>
      ({ closed: ['team-A'], failed: [], skipped: null } as ShutdownTeammatesResult),
    );
    const archiveFn = vi.fn(async (_sid: string) => undefined);
    const getFn = vi.fn(() => {
      throw new Error('simulated SQLite locked');
    });
    const emitFn = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runBatonCleanup(
      {
        callerSessionId: 'caller',
        keepTeammates: false,
        toolName: 'archive_plan',
      },
      { shutdownTeammates: shutdownFn, archiveSession: archiveFn, getSession: getFn, emitArchiveFailed: emitFn },
    );

    // archive-toctou-fix-20260515 plan: getSession 抛错独立分支 (DB 异常状态未知 row 可能仍存在),
    // 与 row 真不存在的 'row-missing' 区分 → 上抛 'probe-throw' 让 UI 显示「可重试归档」按钮
    // (修前老语义吞错归 row-missing 隐藏 UI 重试入口 — LOW probe-throw bug)。
    expect(result.archived).toBe('failed');
    expect(archiveFn).not.toHaveBeenCalled();
    // teammate 段不受 phase 2 异常影响
    expect(result.teammatesShutdown.closed).toEqual(['team-A']);
    expect(emitFn).toHaveBeenCalledTimes(1);
    expect(emitFn).toHaveBeenCalledWith({
      sessionId: 'caller',
      toolName: 'archive_plan',
      reason: expect.stringContaining('probe getSession threw for caller'),
      reasonKind: 'probe-throw',
    });
    // warn 也带「probe getSession threw」前缀方便排查
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('probe getSession threw for caller'),
    );

    warnSpy.mockRestore();
  });

  it('case 8: archiveFn 抛 generic Error (非 SessionRowMissingError) → archive=failed + emit archive-throw (row 仍存在 archive 内部错)', async () => {
    const shutdownFn = vi.fn(async (_sid: string) =>
      ({ closed: ['team-A'], failed: [], skipped: null } as ShutdownTeammatesResult),
    );
    const archiveFn = vi.fn(async (_sid: string) => {
      throw new Error('simulated FK constraint violation');
    });
    const getFn = vi.fn(() => fakeRow('caller'));
    const emitFn = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runBatonCleanup(
      {
        callerSessionId: 'caller',
        keepTeammates: false,
        toolName: 'archive_plan',
      },
      { shutdownTeammates: shutdownFn, archiveSession: archiveFn, getSession: getFn, emitArchiveFailed: emitFn },
    );

    expect(result.archived).toBe('failed');
    expect(archiveFn).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('archive caller caller failed:'),
      expect.any(Error),
    );
    // archive-failure-ux-upthrow-20260515 plan: row 存在但 archive 抛错 → reasonKind='archive-throw',
    // UI 可显示「重试归档」按钮(reason 含 stringified Error message 提供具体错误)。
    // archive-toctou-fix-20260515 plan: instanceof SessionRowMissingError === false → 'archive-throw'
    // 路径(generic Error 走非 row-missing 分支)。
    expect(emitFn).toHaveBeenCalledTimes(1);
    expect(emitFn).toHaveBeenCalledWith({
      sessionId: 'caller',
      toolName: 'archive_plan',
      reason: expect.stringContaining('simulated FK constraint violation'),
      reasonKind: 'archive-throw',
    });

    warnSpy.mockRestore();
  });

  it('case 8b: archiveFn 抛 SessionRowMissingError → race window → archive=failed + emit row-missing (archive-toctou-fix-20260515 R1 reviewer-codex MED-1)', async () => {
    const shutdownFn = vi.fn(async (_sid: string) =>
      ({ closed: ['team-A'], failed: [], skipped: null } as ShutdownTeammatesResult),
    );
    const archiveFn = vi.fn(async (_sid: string) => {
      // 模拟 race window: probe 探针时 row 还在,但 await archive 时 row 已被外部删,
      // setArchived UPDATE 撞 .changes !== 1 → throw SessionRowMissingError
      throw new SessionRowMissingError('caller');
    });
    const getFn = vi.fn(() => fakeRow('caller'));
    const emitFn = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runBatonCleanup(
      {
        callerSessionId: 'caller',
        keepTeammates: false,
        toolName: 'hand_off_session',
      },
      { shutdownTeammates: shutdownFn, archiveSession: archiveFn, getSession: getFn, emitArchiveFailed: emitFn },
    );

    expect(result.archived).toBe('failed');
    // 关键: instanceof SessionRowMissingError 判别准确归 reasonKind='row-missing' (UI 仅告知不显示
    // 「重试归档」按钮 — row 真不存在重试无效)。修前 catch-all 把 setter no-op 误归 'archive-throw'
    // 误导用户。
    expect(emitFn).toHaveBeenCalledTimes(1);
    expect(emitFn).toHaveBeenCalledWith({
      sessionId: 'caller',
      toolName: 'hand_off_session',
      reason: expect.stringContaining('race window: probe OK 后 setArchived no-op'),
      reasonKind: 'row-missing',
    });
    // warn 包含 race window 提示便于排查
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('setArchived no-op (race window)'),
      expect.any(SessionRowMissingError),
    );

    warnSpy.mockRestore();
  });

  it('case 9: excludeSessionIds 透传给 shutdown helper(REVIEW_36 R2 HIGH-A)+ R2 INFO emit not called 守门', async () => {
    const shutdownFn = vi.fn(
      async (_sid: string, _exclude?: ReadonlySet<string>) =>
        ({ closed: [], failed: [], skipped: null } as ShutdownTeammatesResult),
    );
    const archiveFn = vi.fn(async (_sid: string) => undefined);
    const getFn = vi.fn(() => fakeRow('caller'));
    const emitFn = vi.fn();

    const exclude = new Set<string>(['newly-spawned-sid']);
    await runBatonCleanup(
      {
        callerSessionId: 'caller',
        keepTeammates: false,
        excludeSessionIds: exclude,
        toolName: 'hand_off_session',
      },
      { shutdownTeammates: shutdownFn, archiveSession: archiveFn, getSession: getFn, emitArchiveFailed: emitFn },
    );

    expect(shutdownFn).toHaveBeenCalledTimes(1);
    expect(shutdownFn).toHaveBeenCalledWith('caller', exclude);
    // R2 reviewer-claude INFO 修法: archive ok 路径不该 emit caller-archive-failed (回归保护)
    expect(emitFn).not.toHaveBeenCalled();
  });

  it('case 10: 时序保证 — shutdown 在 archive 之前(callOrder 断言)+ R2 INFO emit not called 守门', async () => {
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
    const emitFn = vi.fn();

    await runBatonCleanup(
      {
        callerSessionId: 'caller',
        keepTeammates: false,
        toolName: 'archive_plan',
      },
      { shutdownTeammates: shutdownFn, archiveSession: archiveFn, getSession: getFn, emitArchiveFailed: emitFn },
    );

    // 关键: shutdown 必须在 getSession + archive 之前(详 baton-cleanup.ts 顶部注释「时序保证」)
    expect(order).toEqual(['shutdown', 'getSession', 'archive']);
    // R2 reviewer-claude INFO 修法: archive ok 路径不该 emit caller-archive-failed (回归保护)
    expect(emitFn).not.toHaveBeenCalled();
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
