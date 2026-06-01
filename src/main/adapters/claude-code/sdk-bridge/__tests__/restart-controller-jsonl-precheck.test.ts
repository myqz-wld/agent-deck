/**
 * plan restart-controller-jsonl-precheck-20260521 §D5 测试矩阵 - restart-controller caller 集成测试。
 *
 * 覆盖 restartWithPermissionMode + restartWithClaudeCodeSandbox 调 maybeJsonlFallback helper 的
 * caller 路径行为:
 * - T1: jsonl 在 → fellBack=false → 走原 resume 路径 createSession 一次 + opts.resumeCliSid 正确
 * - T3: jsonl 缺失 + helper.createSession 抛错 → DB 回滚 + emit error + throw
 *
 * **测试方式**: new RestartController + mock RestartCtx (含 jsonlExistsThunk / summariseFn /
 * listEventsFn 3 个 Step 3c 新字段),不走 ClaudeSdkBridge facade。让 ctx.createSession spy 验证
 * caller 透传给 helper / 透传给原 resume 路径 createSession 的 opts。
 *
 * **不重复测**:
 * - helper 内部行为 (T2/T4/T7/T8/T9/T10): 见 jsonl-fallback.test.ts
 * - T5 thunk fail-safe: 由 thunk 自己负责契约 (defaultResumeJsonlExists try/catch),trivial 不测
 * - T6 handoffPrompt 空校验: 行为不变于本次改动,line 89-91 / 260-264 trivial throw
 * - fork rename race: 见 restart-controller-fork-rename.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RestartController, type RestartCtx, type RestartCreateOpts } from '../restart-controller';
import type { AgentEvent, SessionRecord } from '@shared/types';
import type { SdkSessionHandle } from '../types';

// sessionRepo / sessionManager mock 让 RestartController 不撞依赖
const repoCache = new Map<string, SessionRecord>();
const setPermissionModeSpy = vi.fn();
const setClaudeCodeSandboxSpy = vi.fn();

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: vi.fn((sid: string) => repoCache.get(sid) ?? null),
    setPermissionMode: (sid: string, mode: unknown) => {
      setPermissionModeSpy(sid, mode);
      const rec = repoCache.get(sid);
      if (rec) (rec as { permissionMode: unknown }).permissionMode = mode;
    },
    setClaudeCodeSandbox: (sid: string, sandbox: unknown) => {
      setClaudeCodeSandboxSpy(sid, sandbox);
      const rec = repoCache.get(sid);
      if (rec) (rec as { claudeCodeSandbox: unknown }).claudeCodeSandbox = sandbox;
    },
  },
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    renameSdkSession: vi.fn(),
    updateCliSessionId: vi.fn(),
  },
}));

const emits: AgentEvent[] = [];

function makeRec(
  sid: string,
  overrides?: Partial<{
    cliSessionId: string | null;
    permissionMode: string;
    claudeCodeSandbox: string;
    cwd: string;
  }>,
): SessionRecord {
  return {
    id: sid,
    cwd: overrides?.cwd ?? '/tmp/test',
    adapter: 'claude-code',
    title: null,
    lifecycle: 'active',
    permissionMode: overrides?.permissionMode ?? 'default',
    claudeCodeSandbox: overrides?.claudeCodeSandbox ?? 'workspace-write',
    cliSessionId: overrides?.cliSessionId ?? sid,
    model: null,
    extraAllowWrite: null,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    lastEventAt: 0,
    spawnDepth: 0,
    spawnedBy: null,
  } as unknown as SessionRecord;
}

interface MakeCtxOpts {
  jsonlExistsReturn?: boolean;
  createSession?: (opts: RestartCreateOpts) => Promise<SdkSessionHandle>;
  summariseFnReturn?: string | null;
  listEventsFnReturn?: AgentEvent[];
  /** plan resume-inject §D5: message-only 返回（拼原始对话段）。默认空数组。 */
  listMessagesFnReturn?: (AgentEvent & { id: number })[];
}

function makeCtx(opts: MakeCtxOpts = {}): {
  ctx: RestartCtx;
  createSessionSpy: ReturnType<typeof vi.fn>;
} {
  const recovering = new Map<string, Promise<unknown>>();
  const createSessionSpy = vi.fn(
    opts.createSession ??
      (async (_o: RestartCreateOpts) =>
        ({ sessionId: 'restart-stub-sid' }) as SdkSessionHandle),
  );
  const ctx: RestartCtx = {
    recovering,
    emit: (e) => emits.push(e),
    closeSession: async () => undefined,
    createSession: createSessionSpy as unknown as RestartCtx['createSession'],
    jsonlExistsThunk: () => opts.jsonlExistsReturn ?? true,
    summariseFn: async () => opts.summariseFnReturn ?? null,
    listEventsFn: () => opts.listEventsFnReturn ?? [],
    listMessagesFn: () => opts.listMessagesFnReturn ?? [], // plan resume-inject §D5: message-only stub
  };
  return { ctx, createSessionSpy };
}

beforeEach(() => {
  emits.length = 0;
  repoCache.clear();
  setPermissionModeSpy.mockClear();
  setClaudeCodeSandboxSpy.mockClear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Phase Step 3d/3e — restartWithPermissionMode helper integration (jsonl 在/缺失/抛错)', () => {
  it('T1-pm: jsonl 在 → fellBack=false → 走原 resume 路径 createSession 一次 + opts.resumeCliSid 含 rec.cliSessionId 兜底', async () => {
    const sid = 'app-sid-pm-T1';
    repoCache.set(sid, makeRec(sid, { cliSessionId: 'cli-sid-PM', permissionMode: 'default' }));
    const { ctx, createSessionSpy } = makeCtx({ jsonlExistsReturn: true });
    const ctrl = new RestartController(ctx);

    const result = await ctrl.restartWithPermissionMode(sid, 'plan', '继续之前的会话');

    expect(result).toBe(sid); // applicationSid 全程不变
    expect(createSessionSpy).toHaveBeenCalledOnce(); // 只调原 resume 路径一次 (helper 没 createSession)
    const opts = createSessionSpy.mock.calls[0][0] as RestartCreateOpts;
    expect(opts.resume).toBe(sid);
    expect(opts.resumeCliSid).toBe('cli-sid-PM'); // §不变量 8: resumeCliSid: rec.cliSessionId ?? currentSid
    expect(opts.permissionMode).toBe('plan');
    // 不变量 8 验证: 现行 resume 路径行为不退化
  });

  it('T3-pm: jsonl 缺失 + helper.createSession 抛错 → DB 回滚 oldMode + emit error + throw', async () => {
    const sid = 'app-sid-pm-T3';
    repoCache.set(sid, makeRec(sid, { cliSessionId: 'cli-sid-PM', permissionMode: 'default' }));
    const { ctx } = makeCtx({
      jsonlExistsReturn: false, // jsonl 缺失 → 走 helper fallback 路径
      createSession: async () => {
        throw new Error('SDK 启动失败');
      },
    });
    const ctrl = new RestartController(ctx);

    await expect(ctrl.restartWithPermissionMode(sid, 'plan', '继续之前的会话')).rejects.toThrow(
      'SDK 启动失败',
    );

    // 1. DB 回滚: setPermissionMode 被调两次 (① 写新 'plan' ② 回滚 'default')
    expect(setPermissionModeSpy).toHaveBeenCalledTimes(2);
    expect(setPermissionModeSpy.mock.calls[0]).toEqual([sid, 'plan']); // 写新
    expect(setPermissionModeSpy.mock.calls[1]).toEqual([sid, 'default']); // 回滚

    // 2. emit error message: 占位 + error,error 内容含 "切到 plan 失败"
    const errorMsg = emits.find(
      (e) => e.kind === 'message' && (e.payload as { error?: boolean }).error === true,
    );
    expect(errorMsg).toBeDefined();
    expect((errorMsg!.payload as { text: string }).text).toContain('切到 plan 失败');
    expect((errorMsg!.payload as { text: string }).text).toContain('SDK 启动失败');
  });
});

describe('Phase Step 3d/3e — restartWithClaudeCodeSandbox helper integration (jsonl 在/缺失/抛错)', () => {
  it('T1-sandbox: jsonl 在 → fellBack=false → 走原 resume 路径 createSession 一次 + opts.resumeCliSid 含 rec.cliSessionId 兜底', async () => {
    const sid = 'app-sid-sb-T1';
    repoCache.set(
      sid,
      makeRec(sid, { cliSessionId: 'cli-sid-SB', claudeCodeSandbox: 'workspace-write' }),
    );
    const { ctx, createSessionSpy } = makeCtx({ jsonlExistsReturn: true });
    const ctrl = new RestartController(ctx);

    const result = await ctrl.restartWithClaudeCodeSandbox(sid, 'strict', '继续之前的会话');

    expect(result).toBe(sid); // applicationSid 全程不变
    expect(createSessionSpy).toHaveBeenCalledOnce(); // 只调原 resume 路径一次
    const opts = createSessionSpy.mock.calls[0][0] as RestartCreateOpts;
    expect(opts.resume).toBe(sid);
    expect(opts.resumeCliSid).toBe('cli-sid-SB');
    expect(opts.claudeCodeSandbox).toBe('strict');
  });

  it('T3-sandbox: jsonl 缺失 + helper.createSession 抛错 → DB 回滚 oldSandbox + emit error + throw', async () => {
    const sid = 'app-sid-sb-T3';
    repoCache.set(
      sid,
      makeRec(sid, { cliSessionId: 'cli-sid-SB', claudeCodeSandbox: 'workspace-write' }),
    );
    const { ctx } = makeCtx({
      jsonlExistsReturn: false,
      createSession: async () => {
        throw new Error('SDK 启动失败');
      },
    });
    const ctrl = new RestartController(ctx);

    await expect(ctrl.restartWithClaudeCodeSandbox(sid, 'strict', '继续之前的会话')).rejects.toThrow(
      'SDK 启动失败',
    );

    // 1. DB 回滚: setClaudeCodeSandbox 被调两次 (① 写新 'strict' ② 回滚 'workspace-write')
    expect(setClaudeCodeSandboxSpy).toHaveBeenCalledTimes(2);
    expect(setClaudeCodeSandboxSpy.mock.calls[0]).toEqual([sid, 'strict']);
    expect(setClaudeCodeSandboxSpy.mock.calls[1]).toEqual([sid, 'workspace-write']);

    // 2. emit error message
    const errorMsg = emits.find(
      (e) => e.kind === 'message' && (e.payload as { error?: boolean }).error === true,
    );
    expect(errorMsg).toBeDefined();
    expect((errorMsg!.payload as { text: string }).text).toContain('切到 sandbox strict 失败');
    expect((errorMsg!.payload as { text: string }).text).toContain('SDK 启动失败');
  });
});
