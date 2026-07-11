/**
 * plan restart-controller-jsonl-precheck-20260521 §D5 测试矩阵 - restart-controller caller 集成测试。
 *
 * 覆盖 restartWithPermissionMode + restartWithClaudeCodeSandbox 调 maybeJsonlFallback helper 的
 * caller 路径行为:
 * - T1: jsonl 在 → fellBack=false → 走原 resume 路径 createSession 一次 + opts.resumeCliSid 正确
 * - T3: jsonl 缺失 + helper.createSession 抛错 → DB 回滚 + emit error + throw
 * - 关闭项回归: bypassPermissions / sandbox off 的 jsonl 在与缺失 fallback 均保留目标档位
 * **测试方式**: new RestartController + mock RestartCtx，不走 ClaudeSdkBridge facade。让
 * ctx.createSession spy 验证
 * caller 透传给 helper / 透传给原 resume 路径 createSession 的 opts。
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
import { createTrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import type {
  CapturedRecoveryContinuation,
  PreparedRecoveryContinuation,
} from '@main/session/continuation-context/recovery';
import type { PreparedContinuationContext } from '@main/session/continuation-context/types';

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
    setThinking: vi.fn(),
  },
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    renameSdkSession: vi.fn(),
    updateCliSessionId: vi.fn(),
  },
}));

const emits: AgentEvent[] = [];

function captureFor(session: SessionRecord): CapturedRecoveryContinuation {
  return {
    sourceSessionId: session.id,
    spoolId: `spool-${session.id}`,
    generator: {
      adapter: 'claude-code', model: null, thinking: 'medium',
      contextWindowTokens: null, configFingerprint: 'generator',
    },
    target: {
      adapter: 'claude-code', model: session.model ?? null, thinking: null, sandbox: null,
      permissionMode: session.permissionMode ?? null, networkAccessEnabled: null,
      additionalDirectories: [], contextWindowTokens: 128_000, runtimeFingerprint: 'target',
    },
    rawRetentionCeilingTokens: 64_000,
  };
}

function prepareFor(
  input: { capture: CapturedRecoveryContinuation; continuationInstruction: string },
  quality: PreparedContinuationContext['quality'],
): PreparedRecoveryContinuation {
  const prepared: PreparedContinuationContext = {
    version: 1,
    providerPrompt: `===== Agent Deck Continuation Context v1 =====\n${input.continuationInstruction}`,
    persistedUserText: input.continuationInstruction,
    source: { eventRevision: 1, rebuildAfterRevision: 0, maxEventId: 1 },
    checkpoint: { id: 1, throughRevision: 1, formatVersion: 1, refreshed: false },
    projection: { canonicalHash: 'canonical', omittedFacts: 0 },
    quality,
    metrics: {
      rawRetentionCeilingTokens: 64_000, targetPromptCapacityTokens: 104_000,
      checkpointProjectionBudgetTokens: 12_000, generatorFoldInputBudgetTokens: 32_000,
      estimatedPromptTokens: 100, checkpointTokens: 20, rawTailTokens: 20,
      includedUserMessages: quality === 'instruction-only' ? 0 : 1,
      truncatedBoundaryMessages: 0, foldCalls: 1, repairCalls: 0, elapsedMs: 1,
      uncoveredRevisionRange: null,
    },
    warnings: [], preparationHash: 'c'.repeat(64), spoolId: input.capture.spoolId,
  };
  return {
    prepared,
    turn: createTrustedContinuationInitialTurn(prepared, input.capture.sourceSessionId),
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
  continuationQuality?: PreparedContinuationContext['quality'];
  latestConversationMessageTs?: number | null;
  captureThrow?: Error;
}

function makeCtx(opts: MakeCtxOpts = {}): {
  ctx: RestartCtx;
  createSessionSpy: ReturnType<typeof vi.fn>;
  closeCalls: Array<{ sid: string; opts?: { markRecentlyDeleted?: boolean } }>;
  captureSnapshots: Array<{ emitCount: number; closeCount: number; input: unknown }>;
  cleanupSpy: ReturnType<typeof vi.fn>;
} {
  const recovering = new Map<string, Promise<unknown>>();
  const closeCalls: Array<{ sid: string; opts?: { markRecentlyDeleted?: boolean } }> = [];
  const captureSnapshots: Array<{ emitCount: number; closeCount: number; input: unknown }> = [];
  const cleanupSpy = vi.fn();
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
    latestConversationMessageTsThunk: () => opts.latestConversationMessageTs ?? null,
    captureRecoveryContinuation: (input) => {
      captureSnapshots.push({ emitCount: emits.length, closeCount: closeCalls.length, input });
      if (opts.captureThrow) throw opts.captureThrow;
      return captureFor(input.session);
    },
    prepareRecoveryContinuation: async (input) =>
      prepareFor(input, opts.continuationQuality ?? 'instruction-only'),
    cleanupRecoveryContinuation: cleanupSpy,
  };
  return { ctx, createSessionSpy, closeCalls, captureSnapshots, cleanupSpy };
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

  it('capture 失败不阻断 native jsonl restart', async () => {
    const sid = 'app-sid-capture-native';
    repoCache.set(sid, makeRec(sid, { cliSessionId: 'cli-capture-native' }));
    const { ctx, createSessionSpy } = makeCtx({
      jsonlExistsReturn: true,
      captureThrow: new Error('sqlite temp unavailable'),
    });

    const result = await new RestartController(ctx).restartWithPermissionMode(
      sid,
      'plan',
      SDK_RESTART_RESUME_PROMPT,
    );

    expect(result).toBe(sid);
    expect(createSessionSpy).toHaveBeenCalledOnce();
    expect(createSessionSpy.mock.calls[0][0]).toMatchObject({
      prompt: SDK_RESTART_RESUME_PROMPT,
      resume: sid,
      resumeCliSid: 'cli-capture-native',
    });
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
    const { ctx, createSessionSpy, closeCalls, captureSnapshots, cleanupSpy } = makeCtx({
      jsonlExistsReturn: false,
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
    expect(opts.prompt).toBeUndefined();
    expect(opts.trustedContinuation?.providerPrompt).toContain(
      'Agent Deck Continuation Context v1',
    );
    const persisted = emits.find(
      (event) =>
        event.kind === 'message' &&
        (event.payload as { role?: string }).role === 'user',
    );
    expect(persisted?.payload).toMatchObject({
      text: '继续之前的会话',
      messageOrigin: 'continuation',
      continuation: { sourceSessionId: sid },
    });
    expect(setPermissionModeSpy).toHaveBeenCalledOnce();
    expect(setPermissionModeSpy.mock.calls[0]).toEqual([sid, 'bypassPermissions']);
    expect(closeCalls).toEqual([{ sid, opts: { markRecentlyDeleted: false } }]);
    expect(captureSnapshots[0]).toMatchObject({
      emitCount: 0,
      closeCount: 0,
      input: { overrides: { permissionMode: 'bypassPermissions' } },
    });
    expect(cleanupSpy).toHaveBeenCalledOnce();
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
    const { ctx, createSessionSpy, closeCalls, captureSnapshots, cleanupSpy } = makeCtx({
      jsonlExistsReturn: false,
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
    expect(opts.prompt).toBeUndefined();
    expect(opts.trustedContinuation?.providerPrompt).toContain(
      'Agent Deck Continuation Context v1',
    );
    const persisted = emits.find(
      (event) =>
        event.kind === 'message' &&
        (event.payload as { role?: string }).role === 'user',
    );
    expect(persisted?.payload).toMatchObject({
      text: '继续之前的会话',
      messageOrigin: 'continuation',
      continuation: { sourceSessionId: sid },
    });
    expect(setClaudeCodeSandboxSpy).toHaveBeenCalledOnce();
    expect(setClaudeCodeSandboxSpy.mock.calls[0]).toEqual([sid, 'off']);
    expect(closeCalls).toEqual([{ sid, opts: { markRecentlyDeleted: false } }]);
    expect(captureSnapshots[0]).toMatchObject({
      emitCount: 0,
      closeCount: 0,
      input: { overrides: { claudeCodeSandbox: 'off' } },
    });
    expect(cleanupSpy).toHaveBeenCalledOnce();
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
