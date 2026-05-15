/**
 * sessions.ts handOffSpawn helper 单测（REVIEW_33 H6 / H7）
 *
 * 关键验证：
 * - H6: buildHandOffCreateSessionOpts 必须把原 session 的 codexSandbox /
 *   claudeCodeSandbox 透传到新 session createSession opts，避免用户切沙盒后
 *   hand-off 起的新 session 落 settings 全局默认（隐性沙盒 downgrade）。
 * - H7: dedupHandOff 必须按 sourceSid 单飞 — 同 sid 并发只起一次 work；不同 sid
 *   彼此独立；resolve / reject 后 entry 自动清，下次同 sid 仍可正常起。
 *
 * 纯函数测试，import sessions-hand-off-helper 而非 sessions.ts，避免拉起 Electron
 * import 链（sessions.ts 通过 sessionManager / sessionRepo / eventBus 间接 import
 * Electron / SQLite）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildHandOffCreateSessionOpts,
  dedupHandOff,
  handOffInflight,
  archiveSourceSessionWithEmit,
} from '../sessions-hand-off-helper';
import type { SessionRecord } from '@shared/types';
import type { CreateSessionOptions } from '@main/adapters/types';
import { SessionRowMissingError } from '@main/store/session-repo';

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sid-1',
    agentId: 'claude-code',
    cwd: '/Users/test/project',
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
    ...overrides,
  } as SessionRecord;
}

describe('buildHandOffCreateSessionOpts — REVIEW_33 H6 sandbox 透传', () => {
  it('原 session 无 permissionMode / sandbox → opts 只含 agentId + cwd + prompt（不写空字段，让 adapter 走 fallback）', () => {
    const session = makeSession();
    const opts = buildHandOffCreateSessionOpts(session, 'continue from prev');
    // p4-d2-impl Step 2.2：buildHandOffCreateSessionOpts 改用 buildCreateSessionOptions
    // builder helper 自动塞 agentId 字段（按 session.agentId narrow 到对应 union arm）。
    expect(opts).toEqual({
      agentId: 'claude-code',
      cwd: '/Users/test/project',
      prompt: 'continue from prev',
    });
    // 关键：不应有 permissionMode / codexSandbox / claudeCodeSandbox 字段
    expect('permissionMode' in opts).toBe(false);
    expect('codexSandbox' in opts).toBe(false);
    expect('claudeCodeSandbox' in opts).toBe(false);
  });

  it('原 session permissionMode=acceptEdits → opts 透传', () => {
    const session = makeSession({ permissionMode: 'acceptEdits' });
    const opts = buildHandOffCreateSessionOpts(session, 'p');
    // p4-d2-impl: session.agentId default 'claude-code' → narrowToClaudeOpts → opts 含 permissionMode
    const claudeOpts = opts as Extract<CreateSessionOptions, { agentId: 'claude-code' }>;
    expect(claudeOpts.permissionMode).toBe('acceptEdits');
  });

  it('REVIEW_33 H6 核心：codexSandbox=read-only → 必须透传（修前漏 → 隐性沙盒 downgrade 到 workspace-write 全局默认）', () => {
    const session = makeSession({ agentId: 'codex-cli', codexSandbox: 'read-only' });
    const opts = buildHandOffCreateSessionOpts(session, 'p');
    // p4-d2-impl: session.agentId='codex-cli' → narrowToCodexOpts → opts 含 codexSandbox
    const codexOpts = opts as Extract<CreateSessionOptions, { agentId: 'codex-cli' }>;
    expect(codexOpts.codexSandbox).toBe('read-only');
  });

  it('REVIEW_33 H6 核心：claudeCodeSandbox=strict → 必须透传（修前漏 → 隐性沙盒 downgrade 到 off 全局默认）', () => {
    const session = makeSession({ claudeCodeSandbox: 'strict' });
    const opts = buildHandOffCreateSessionOpts(session, 'p');
    // p4-d2-impl: session.agentId default 'claude-code' → narrowToClaudeOpts → opts 含 claudeCodeSandbox
    const claudeOpts = opts as Extract<CreateSessionOptions, { agentId: 'claude-code' }>;
    expect(claudeOpts.claudeCodeSandbox).toBe('strict');
  });

  it('claude session 全字段：agentId + cwd + prompt + permissionMode + claudeCodeSandbox 全在 opts 内（codexSandbox 被 D2 narrow filter 掉）', () => {
    // p4-d2-impl Step 2.2：D2 强约束让 buildHandOffCreateSessionOpts 按 session.agentId
    // narrow 到对应 union arm — claude session.codexSandbox 字段在 narrow 时 filter 掉
    // （ClaudeCreateOpts 不含 codexSandbox 字段，让 caller TS 编译期阻止字段误传）。
    // 修前 buildHandOffCreateSessionOpts 是宽 union 不挑 adapter 透传所有字段；现按
    // session.agentId narrow 后跨 adapter 字段被 filter（行为变化但符合 sessions table
    // 现实 — 一个 session row 一个 adapter，不可能同时设 claudeCodeSandbox + codexSandbox）。
    const session = makeSession({
      permissionMode: 'plan',
      codexSandbox: 'workspace-write', // claude session 不消费 codexSandbox，narrow filter 掉
      claudeCodeSandbox: 'workspace-write',
    });
    const opts = buildHandOffCreateSessionOpts(session, 'continue work');
    expect(opts).toEqual({
      agentId: 'claude-code',
      cwd: '/Users/test/project',
      prompt: 'continue work',
      permissionMode: 'plan',
      claudeCodeSandbox: 'workspace-write',
      // 注意：没有 codexSandbox — D2 narrow filter
    });
    expect('codexSandbox' in opts).toBe(false);
  });

  it('codex session 全字段：agentId + cwd + prompt + codexSandbox 全在 opts 内（permissionMode + claudeCodeSandbox 被 D2 narrow filter 掉）', () => {
    // p4-d2-impl Step 2.2：D2 强约束 codex session narrow 到 CodexCreateOpts，filter 掉
    // permissionMode（codex 不支持运行时 permission mode，approvalPolicy 是 startThread
    // 一次性配置）+ claudeCodeSandbox（claude 专属字段）。
    const session = makeSession({
      agentId: 'codex-cli',
      permissionMode: 'plan', // codex 不消费 permissionMode，narrow filter 掉
      codexSandbox: 'workspace-write',
      claudeCodeSandbox: 'strict', // codex 不消费 claudeCodeSandbox，narrow filter 掉
    });
    const opts = buildHandOffCreateSessionOpts(session, 'continue work');
    expect(opts).toEqual({
      agentId: 'codex-cli',
      cwd: '/Users/test/project',
      prompt: 'continue work',
      codexSandbox: 'workspace-write',
      // 注意：没有 permissionMode / claudeCodeSandbox — D2 narrow filter
    });
    expect('permissionMode' in opts).toBe(false);
    expect('claudeCodeSandbox' in opts).toBe(false);
  });

  it('null 字段（DB 列允许 null）→ 不写 opts（走 fallback）', () => {
    const session = makeSession({
      permissionMode: undefined,
      codexSandbox: null,
      claudeCodeSandbox: null,
    });
    const opts = buildHandOffCreateSessionOpts(session, 'p');
    expect('permissionMode' in opts).toBe(false);
    expect('codexSandbox' in opts).toBe(false);
    expect('claudeCodeSandbox' in opts).toBe(false);
  });

  it('permissionMode=default 也透传（与原 session 行为完全对齐，不挑挑拣拣）', () => {
    // 注：原 handler line 119 的 recordCreatedPermissionMode 才会跳过 'default'，
    // 但 opts 透传仍按 truthy 规则把 'default' 字符串透传过去（adapter 收到 'default'
    // 就当 default 处理 — 与 settings.permissionMode 全局值合并由 adapter 决定）。
    const session = makeSession({ permissionMode: 'default' });
    const opts = buildHandOffCreateSessionOpts(session, 'p');
    // p4-d2-impl: session.agentId default 'claude-code' → narrowToClaudeOpts
    const claudeOpts = opts as Extract<CreateSessionOptions, { agentId: 'claude-code' }>;
    expect(claudeOpts.permissionMode).toBe('default');
  });
});

describe('dedupHandOff — REVIEW_33 H7 inflight Map 单飞', () => {
  beforeEach(() => {
    handOffInflight.clear();
  });

  it('同 sid 并发：只起一次 work，两个 caller 拿同 newSid', async () => {
    let workCallCount = 0;
    const work = vi.fn(async () => {
      workCallCount++;
      // 模拟真实 createSession：异步几个 tick
      await new Promise((r) => setTimeout(r, 10));
      return 'new-sid-1';
    });

    // 并发触发两次（模拟双击 race / 双 IPC 同时入 handler）
    const [a, b] = await Promise.all([
      dedupHandOff('source-sid-1', work),
      dedupHandOff('source-sid-1', work),
    ]);

    expect(a).toBe('new-sid-1');
    expect(b).toBe('new-sid-1');
    expect(workCallCount).toBe(1); // 只起一次！
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('同 sid 三连击：仍只起一次 work', async () => {
    let workCallCount = 0;
    const work = async () => {
      workCallCount++;
      await new Promise((r) => setTimeout(r, 10));
      return 'new-sid-2';
    };

    const [a, b, c] = await Promise.all([
      dedupHandOff('source-sid-2', work),
      dedupHandOff('source-sid-2', work),
      dedupHandOff('source-sid-2', work),
    ]);

    expect(a).toBe('new-sid-2');
    expect(b).toBe('new-sid-2');
    expect(c).toBe('new-sid-2');
    expect(workCallCount).toBe(1);
  });

  it('不同 sid 并发：彼此独立，各起各的 work', async () => {
    let workACalls = 0;
    let workBCalls = 0;
    const workA = async () => {
      workACalls++;
      await new Promise((r) => setTimeout(r, 5));
      return 'new-A';
    };
    const workB = async () => {
      workBCalls++;
      await new Promise((r) => setTimeout(r, 5));
      return 'new-B';
    };

    const [a, b] = await Promise.all([
      dedupHandOff('sid-A', workA),
      dedupHandOff('sid-B', workB),
    ]);

    expect(a).toBe('new-A');
    expect(b).toBe('new-B');
    expect(workACalls).toBe(1);
    expect(workBCalls).toBe(1);
  });

  it('resolve 后 entry 自动清：下次同 sid 可以正常起新 hand-off', async () => {
    const work1 = async () => 'first-call';
    const work2 = async () => 'second-call';

    const r1 = await dedupHandOff('sid-1', work1);
    expect(r1).toBe('first-call');
    expect(handOffInflight.has('sid-1')).toBe(false); // resolve 后清

    // 下一次调用走新 work（不复用上次的 'first-call'）
    const r2 = await dedupHandOff('sid-1', work2);
    expect(r2).toBe('second-call');
  });

  it('reject 后 entry 自动清：下次同 sid 可以正常重试', async () => {
    const errorWork = async () => {
      throw new Error('createSession failed');
    };
    const successWork = async () => 'success';

    await expect(dedupHandOff('sid-fail', errorWork)).rejects.toThrow('createSession failed');
    expect(handOffInflight.has('sid-fail')).toBe(false); // reject 后也要清！

    // 重试走新 work，成功
    const r = await dedupHandOff('sid-fail', successWork);
    expect(r).toBe('success');
  });

  it('reject 时并发 caller 都拿到 same error', async () => {
    let workCallCount = 0;
    const work = async () => {
      workCallCount++;
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('shared failure');
    };

    const [a, b] = await Promise.allSettled([
      dedupHandOff('sid-rej', work),
      dedupHandOff('sid-rej', work),
    ]);

    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    expect((a as PromiseRejectedResult).reason.message).toBe('shared failure');
    expect((b as PromiseRejectedResult).reason.message).toBe('shared failure');
    expect(workCallCount).toBe(1); // 仍只起一次
  });

  it('strict equal 保护：第一个 Promise resolve 时不误删第二个 Promise 的 entry', async () => {
    // edge case：dedupHandOff 内 finally 用 strict equal 守门防止误删别人的 entry
    let resolveFirst: ((v: string) => void) | null = null;
    const firstWork = () => new Promise<string>((res) => { resolveFirst = res; });

    // 第一次调用，注册 entry
    const p1 = dedupHandOff('shared-sid', firstWork);
    expect(handOffInflight.has('shared-sid')).toBe(true);

    // 模拟手动 mutate（罕见 race 假设：第二次 set 覆盖了第一个的 entry，虽然实际
    // dedupHandOff 不会进 work 第二次，但单测验证 finally 守门正确）
    const replacementPromise = Promise.resolve('replacement');
    handOffInflight.set('shared-sid', replacementPromise);

    // resolve 第一个 Promise → finally 应当**不删** entry（因为 entry 不再是 p1）
    resolveFirst!('first-resolved');
    await p1;
    expect(handOffInflight.get('shared-sid')).toBe(replacementPromise); // 第二个 entry 仍在

    handOffInflight.delete('shared-sid'); // cleanup
  });
});

describe('archiveSourceSessionWithEmit — archive-failure-ux-upthrow-20260515 plan', () => {
  /** 构造 fake row(测试不在乎字段细节,只在乎 truthy/null) */
  function fakeRow() {
    return { id: 'fake', archivedAt: null } as unknown;
  }

  it('archive ok → emitArchiveFailed 不被调用(happy path 不误打扰)', async () => {
    const archiveFn = vi.fn(async (_sid: string) => undefined);
    const getFn = vi.fn(() => fakeRow());
    const emitFn = vi.fn();

    await archiveSourceSessionWithEmit('source-sid', {
      archive: archiveFn,
      getSession: getFn,
      emitArchiveFailed: emitFn,
    });

    expect(getFn).toHaveBeenCalledTimes(1);
    expect(getFn).toHaveBeenCalledWith('source-sid');
    expect(archiveFn).toHaveBeenCalledTimes(1);
    expect(archiveFn).toHaveBeenCalledWith('source-sid');
    expect(emitFn).not.toHaveBeenCalled();
  });

  it('archive 抛 generic Error (非 SessionRowMissingError) → emit archive-throw + reason 含 Error message + 不抛 (by design)', async () => {
    const archiveFn = vi.fn(async (_sid: string) => {
      throw new Error('FK constraint violation');
    });
    const getFn = vi.fn(() => fakeRow());
    const emitFn = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      archiveSourceSessionWithEmit('source-sid', {
        archive: archiveFn,
        getSession: getFn,
        emitArchiveFailed: emitFn,
      }),
    ).resolves.toBeUndefined();

    expect(emitFn).toHaveBeenCalledTimes(1);
    // archive-toctou-fix-20260515 plan: instanceof SessionRowMissingError === false (generic Error)
    // → 'archive-throw' 路径,UI 显示「重试归档」按钮。
    expect(emitFn).toHaveBeenCalledWith({
      sessionId: 'source-sid',
      toolName: 'SessionHandOffSpawn',
      reason: expect.stringContaining('FK constraint violation'),
      reasonKind: 'archive-throw',
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ipc sessions hand-off] archive source session source-sid failed:'),
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  it('archive 抛 SessionRowMissingError → race window → emit row-missing (archive-toctou-fix-20260515 R1 reviewer-codex MED-1)', async () => {
    const archiveFn = vi.fn(async (_sid: string) => {
      // 模拟 race window: createSession 期间 source row 被删,setArchived UPDATE no-op throw
      throw new SessionRowMissingError('source-sid');
    });
    const getFn = vi.fn(() => fakeRow());
    const emitFn = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await archiveSourceSessionWithEmit('source-sid', {
      archive: archiveFn,
      getSession: getFn,
      emitArchiveFailed: emitFn,
    });

    expect(emitFn).toHaveBeenCalledTimes(1);
    // 关键: instanceof SessionRowMissingError === true → reasonKind='row-missing' (UI 仅告知不显
    // 「重试归档」— row 真不存在重试无效)。修前 catch-all 把 setter no-op 误归 'archive-throw'。
    expect(emitFn).toHaveBeenCalledWith({
      sessionId: 'source-sid',
      toolName: 'SessionHandOffSpawn',
      reason: expect.stringContaining('race window: probe OK 后 setArchived no-op'),
      reasonKind: 'row-missing',
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('setArchived no-op (race window)'),
      expect.any(SessionRowMissingError),
    );

    warnSpy.mockRestore();
  });

  it('archive 抛非 Error(e.g. string)→ emit reason 也能 stringify 不挂', async () => {
    const archiveFn = vi.fn(async (_sid: string) => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'opaque error string';
    });
    const getFn = vi.fn(() => fakeRow());
    const emitFn = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await archiveSourceSessionWithEmit('source-sid', {
      archive: archiveFn,
      getSession: getFn,
      emitArchiveFailed: emitFn,
    });

    expect(emitFn).toHaveBeenCalledTimes(1);
    expect(emitFn).toHaveBeenCalledWith({
      sessionId: 'source-sid',
      toolName: 'SessionHandOffSpawn',
      reason: expect.stringContaining('opaque error string'),
      reasonKind: 'archive-throw',
    });

    warnSpy.mockRestore();
  });

  // R2 reviewer-codex MED-1 修法新增 case: 验证 createSession 异步窗口期间 row 被删的场景
  it('R2 MED-1: getSession 返回 null (row missing)→ emit row-missing + 不调 archive', async () => {
    const archiveFn = vi.fn(async (_sid: string) => undefined);
    const getFn = vi.fn(() => null);
    const emitFn = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await archiveSourceSessionWithEmit('ghost-sid', {
      archive: archiveFn,
      getSession: getFn,
      emitArchiveFailed: emitFn,
    });

    // 关键: getSession 探针 null → archive 不调用 (避免 silent no-op resolve 漏 emit)
    expect(getFn).toHaveBeenCalledTimes(1);
    expect(archiveFn).not.toHaveBeenCalled();
    expect(emitFn).toHaveBeenCalledTimes(1);
    expect(emitFn).toHaveBeenCalledWith({
      sessionId: 'ghost-sid',
      toolName: 'SessionHandOffSpawn',
      reason: expect.stringContaining('cannot archive caller ghost-sid: not in sessions table'),
      reasonKind: 'row-missing',
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ipc sessions hand-off]'),
    );

    warnSpy.mockRestore();
  });

  // archive-toctou-fix-20260515 plan: getSession 抛错独立分支 → 'probe-throw' 不再误归 row-missing
  it('archive-toctou-fix-20260515: getSession 抛错 (DB 异常)→ 走 probe-throw 路径 emit (修前误归 row-missing)', async () => {
    const archiveFn = vi.fn(async (_sid: string) => undefined);
    const getFn = vi.fn(() => {
      throw new Error('simulated SQLite locked');
    });
    const emitFn = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await archiveSourceSessionWithEmit('source-sid', {
      archive: archiveFn,
      getSession: getFn,
      emitArchiveFailed: emitFn,
    });

    // 关键: probe 抛错独立分支 'probe-throw' 让 UI 显示「重试归档」按钮(状态未知 row 可能仍存在)。
    // 修前老语义: catch 兜底 row=null → 走 row-missing 路径误导(UI 不显示重试入口)
    expect(archiveFn).not.toHaveBeenCalled();
    expect(emitFn).toHaveBeenCalledWith({
      sessionId: 'source-sid',
      toolName: 'SessionHandOffSpawn',
      reason: expect.stringContaining('probe getSession threw for source-sid'),
      reasonKind: 'probe-throw',
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('probe getSession threw for source-sid'),
    );

    warnSpy.mockRestore();
  });
});
