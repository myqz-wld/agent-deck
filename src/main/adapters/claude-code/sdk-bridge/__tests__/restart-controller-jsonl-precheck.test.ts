/**
 * plan restart-controller-jsonl-precheck-20260521 §D5 测试矩阵 - restart-controller caller 集成测试。
 *
 * 覆盖 restartWithPermissionMode + restartWithClaudeCodeSandbox 调 maybeJsonlFallback helper 的
 * caller 路径行为:
 * - T1: jsonl 在 → fellBack=false → 走原 resume 路径 createSession 一次 + opts.resumeCliSid 正确
 * - T3: jsonl 缺失 + helper.createSession 抛错 → DB 回滚 + emit error + throw
 * - 关闭项回归: bypassPermissions / sandbox off 的 jsonl 在与缺失 fallback 均保留目标档位
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
import { SDK_RESTART_RESUME_PROMPT } from '@shared/restart-prompts';

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

vi.mock('@main/store/settings-store', () => ({
  settingsStore: {
    get: vi.fn((key: string) => (key === 'resumeRecentMessagesCount' ? 30 : undefined)),
  },
}));

const emits: AgentEvent[] = [];

function msg(id: number, role: 'user' | 'assistant', text: string): AgentEvent & { id: number } {
  return {
    id,
    sessionId: 's',
    agentId: 'claude-code',
    kind: 'message',
    payload: { role, text },
    ts: id,
    source: 'sdk',
  };
}

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
  closeCalls: Array<{ sid: string; opts?: { markRecentlyDeleted?: boolean } }>;
} {
  const recovering = new Map<string, Promise<unknown>>();
  const closeCalls: Array<{ sid: string; opts?: { markRecentlyDeleted?: boolean } }> = [];
  const createSessionSpy = vi.fn(
    opts.createSession ??
      (async (_o: RestartCreateOpts) =>
        ({ sessionId: 'restart-stub-sid' }) as SdkSessionHandle),
  );
  const ctx: RestartCtx = {
    recovering,
    emit: (e) => emits.push(e),
    closeSession: async (sid, closeOpts) => {
      closeCalls.push({ sid, opts: closeOpts });
    },
    createSession: createSessionSpy as unknown as RestartCtx['createSession'],
    jsonlExistsThunk: () => opts.jsonlExistsReturn ?? true,
    jsonlMtimeMsThunk: () => 10_000,
    summariseFn: async () => opts.summariseFnReturn ?? null,
    listEventsFn: () => opts.listEventsFnReturn ?? [],
    listMessagesFn: () => opts.listMessagesFnReturn ?? [], // plan resume-inject §D5: message-only stub
  };
  return { ctx, createSessionSpy, closeCalls };
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
    const { ctx, createSessionSpy, closeCalls } = makeCtx({
      jsonlExistsReturn: true,
      summariseFnReturn: '重启前摘要',
      listEventsFnReturn: [
        {
          sessionId: sid,
          agentId: 'claude-code',
          kind: 'message',
          payload: { text: 'x' },
          ts: 1,
          source: 'sdk',
        },
      ],
      listMessagesFnReturn: [msg(2, 'assistant', '历史回答'), msg(1, 'user', '历史问题')],
    });
    const ctrl = new RestartController(ctx);

    const result = await ctrl.restartWithPermissionMode(sid, 'plan', SDK_RESTART_RESUME_PROMPT);

    expect(result).toBe(sid); // applicationSid 全程不变
    expect(createSessionSpy).toHaveBeenCalledOnce(); // 只调原 resume 路径一次 (helper 没 createSession)
    const opts = createSessionSpy.mock.calls[0][0] as RestartCreateOpts;
    expect(opts.resume).toBe(sid);
    expect(opts.resumeCliSid).toBe('cli-sid-PM'); // §不变量 8: resumeCliSid: rec.cliSessionId ?? currentSid
    expect(opts.permissionMode).toBe('plan');
    // CHANGELOG_223：jsonl 在 → handoffPrompt（= SDK_RESTART_RESUME_PROMPT 内部恢复指令）原样透传，
    // CLI --resume 已从 jsonl 续上完整上下文，**不**再注入 221 的 DB 摘要/原始对话（否则模型把整段历史当新输入）。
    expect(opts.prompt).toBe(SDK_RESTART_RESUME_PROMPT);
    expect(opts.prompt).not.toContain('历史会话摘要');
    expect(opts.prompt).not.toContain('最近原始对话消息');
    expect(opts.prompt).not.toContain('[用户] 历史问题');
    expect(closeCalls).toEqual([{ sid, opts: { markRecentlyDeleted: false } }]);
  });

  it('T1-pm-bypass: 切到 bypassPermissions 且 jsonl 在 → 正常 resume，不注入 DB 历史', async () => {
    const sid = 'app-sid-pm-bypass-T1';
    repoCache.set(
      sid,
      makeRec(sid, {
        cliSessionId: 'cli-sid-PM-bypass',
        permissionMode: 'default',
        claudeCodeSandbox: 'off',
      }),
    );
    const { ctx, createSessionSpy, closeCalls } = makeCtx({
      jsonlExistsReturn: true,
      summariseFnReturn: '不应注入的摘要',
      listMessagesFnReturn: [msg(2, 'assistant', '历史回答'), msg(1, 'user', '历史问题')],
    });
    const ctrl = new RestartController(ctx);

    const result = await ctrl.restartWithPermissionMode(
      sid,
      'bypassPermissions',
      SDK_RESTART_RESUME_PROMPT,
    );

    expect(result).toBe(sid);
    expect(createSessionSpy).toHaveBeenCalledOnce();
    const opts = createSessionSpy.mock.calls[0][0] as RestartCreateOpts;
    expect(opts.resume).toBe(sid);
    expect(opts.resumeCliSid).toBe('cli-sid-PM-bypass');
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.claudeCodeSandbox).toBe('off');
    expect(opts.prompt).toBe(SDK_RESTART_RESUME_PROMPT);
    expect(opts.prompt).not.toContain('历史会话摘要');
    expect(opts.prompt).not.toContain('最近原始对话消息');
    expect(closeCalls).toEqual([{ sid, opts: { markRecentlyDeleted: false } }]);
  });

  it('T2-pm-bypass: 切到 bypassPermissions 且 jsonl 缺失 → fresh fallback 保留 bypass/off 档位', async () => {
    const sid = 'app-sid-pm-bypass-T2';
    repoCache.set(
      sid,
      makeRec(sid, {
        cliSessionId: 'cli-sid-PM-bypass',
        permissionMode: 'default',
        claudeCodeSandbox: 'off',
      }),
    );
    const { ctx, createSessionSpy, closeCalls } = makeCtx({
      jsonlExistsReturn: false,
      summariseFnReturn: null,
    });
    const ctrl = new RestartController(ctx);

    const result = await ctrl.restartWithPermissionMode(sid, 'bypassPermissions', '继续之前的会话');

    expect(result).toBe(sid);
    expect(createSessionSpy).toHaveBeenCalledOnce();
    const opts = createSessionSpy.mock.calls[0][0] as RestartCreateOpts;
    expect(opts.resume).toBe(sid);
    expect(opts.resumeMode).toBe('fresh-cli-reuse-app');
    expect('resumeCliSid' in opts).toBe(false);
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.claudeCodeSandbox).toBe('off');
    expect(opts.prompt).toContain('继续之前的会话');
    expect(setPermissionModeSpy).toHaveBeenCalledOnce();
    expect(setPermissionModeSpy.mock.calls[0]).toEqual([sid, 'bypassPermissions']);
    expect(closeCalls).toEqual([{ sid, opts: { markRecentlyDeleted: false } }]);
    expect(emits.some((e) => e.kind === 'message' && (e.payload as { error?: boolean }).error)).toBe(
      false,
    );
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
    const { ctx, createSessionSpy, closeCalls } = makeCtx({
      jsonlExistsReturn: true,
      summariseFnReturn: '沙盒重启摘要',
      listEventsFnReturn: [
        {
          sessionId: sid,
          agentId: 'claude-code',
          kind: 'message',
          payload: { text: 'x' },
          ts: 1,
          source: 'sdk',
        },
      ],
      listMessagesFnReturn: [msg(2, 'assistant', '沙盒历史回答'), msg(1, 'user', '沙盒历史问题')],
    });
    const ctrl = new RestartController(ctx);

    const result = await ctrl.restartWithClaudeCodeSandbox(sid, 'strict', SDK_RESTART_RESUME_PROMPT);

    expect(result).toBe(sid); // applicationSid 全程不变
    expect(createSessionSpy).toHaveBeenCalledOnce(); // 只调原 resume 路径一次
    const opts = createSessionSpy.mock.calls[0][0] as RestartCreateOpts;
    expect(opts.resume).toBe(sid);
    expect(opts.resumeCliSid).toBe('cli-sid-SB');
    expect(opts.claudeCodeSandbox).toBe('strict');
    // CHANGELOG_223：jsonl 在 → handoffPrompt 原样透传，不注入 DB 历史（同 restartWithPermissionMode）。
    expect(opts.prompt).toBe(SDK_RESTART_RESUME_PROMPT);
    expect(opts.prompt).not.toContain('历史会话摘要');
    expect(opts.prompt).not.toContain('沙盒历史问题');
    expect(closeCalls).toEqual([{ sid, opts: { markRecentlyDeleted: false } }]);
  });

  it('T1-sandbox-off: 关闭 sandbox 且 jsonl 在 → 正常 resume，并保留既有 bypass 权限', async () => {
    const sid = 'app-sid-sb-off-T1';
    repoCache.set(
      sid,
      makeRec(sid, {
        cliSessionId: 'cli-sid-SB-off',
        permissionMode: 'bypassPermissions',
        claudeCodeSandbox: 'workspace-write',
      }),
    );
    const { ctx, createSessionSpy, closeCalls } = makeCtx({
      jsonlExistsReturn: true,
      summariseFnReturn: '不应注入的摘要',
      listMessagesFnReturn: [msg(2, 'assistant', '沙盒历史回答'), msg(1, 'user', '沙盒历史问题')],
    });
    const ctrl = new RestartController(ctx);

    const result = await ctrl.restartWithClaudeCodeSandbox(sid, 'off', SDK_RESTART_RESUME_PROMPT);

    expect(result).toBe(sid);
    expect(createSessionSpy).toHaveBeenCalledOnce();
    const opts = createSessionSpy.mock.calls[0][0] as RestartCreateOpts;
    expect(opts.resume).toBe(sid);
    expect(opts.resumeCliSid).toBe('cli-sid-SB-off');
    expect(opts.claudeCodeSandbox).toBe('off');
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.prompt).toBe(SDK_RESTART_RESUME_PROMPT);
    expect(opts.prompt).not.toContain('历史会话摘要');
    expect(opts.prompt).not.toContain('最近原始对话消息');
    expect(closeCalls).toEqual([{ sid, opts: { markRecentlyDeleted: false } }]);
  });

  it('T2-sandbox-off: 关闭 sandbox 且 jsonl 缺失 → fresh fallback 保留 off/bypass 档位', async () => {
    const sid = 'app-sid-sb-off-T2';
    repoCache.set(
      sid,
      makeRec(sid, {
        cliSessionId: 'cli-sid-SB-off',
        permissionMode: 'bypassPermissions',
        claudeCodeSandbox: 'workspace-write',
      }),
    );
    const { ctx, createSessionSpy, closeCalls } = makeCtx({
      jsonlExistsReturn: false,
      summariseFnReturn: null,
    });
    const ctrl = new RestartController(ctx);

    const result = await ctrl.restartWithClaudeCodeSandbox(sid, 'off', '继续之前的会话');

    expect(result).toBe(sid);
    expect(createSessionSpy).toHaveBeenCalledOnce();
    const opts = createSessionSpy.mock.calls[0][0] as RestartCreateOpts;
    expect(opts.resume).toBe(sid);
    expect(opts.resumeMode).toBe('fresh-cli-reuse-app');
    expect('resumeCliSid' in opts).toBe(false);
    expect(opts.claudeCodeSandbox).toBe('off');
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.prompt).toContain('继续之前的会话');
    expect(setClaudeCodeSandboxSpy).toHaveBeenCalledOnce();
    expect(setClaudeCodeSandboxSpy.mock.calls[0]).toEqual([sid, 'off']);
    expect(closeCalls).toEqual([{ sid, opts: { markRecentlyDeleted: false } }]);
    expect(emits.some((e) => e.kind === 'message' && (e.payload as { error?: boolean }).error)).toBe(
      false,
    );
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
