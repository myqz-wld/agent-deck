/**
 * plan restart-controller-jsonl-precheck-20260521 §D5 测试矩阵 - helper 单测部分。
 *
 * 覆盖 maybeJsonlFallback helper 自身行为(不走 facade / 完整 createSession):
 * - T2: jsonl 缺失 → fellBack=true,helper 调 ctx.createSession + emit 2 次 + return finalSessionId
 * - T4: cliSessionId !== sessionId(反向 rename 场景) → helper 用 cliSessionId 找 jsonl
 * - T7: fellBack=true 路径 — 摘要成功 vs 失败两态,emit 对应 builder
 * - T8: 6 个文案 case (recover × cwdFellBack 4 + restart × cwdFellBack=false 2)
 * - T9: ctx.createSession opts 字段 + emit role='user' payload + attachments 三 sub-case (T9a/b/c)
 * - T10: OR 短路 — T10a (cwdFellBack=true + spy.callCount=0);T10b (cwdFellBack=false + spy.callCount=1)
 *
 * **测试方式**: 直接调 module-level `maybeJsonlFallback(ctx, opts)`,ctx 字段全 stub
 * (jsonlExistsThunk / createSession / emit / summariseFn / listEventsFn),不走 facade /
 * 完整 createSession,纯函数 input/output 验证。
 *
 * **不测**(由 Step 3a.5 guard 单点 if 已 typecheck 验证,无需 runtime test):
 * - createSession 内部 finalizeSessionStart skip
 * - createSession 内部 stream-processor S3 fresh-cli-reuse-app 分支 updateCliSessionId
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  maybeJsonlFallback,
  type JsonlFallbackCtx,
  type JsonlFallbackOpts,
} from '../jsonl-fallback';
import type { AgentEvent, UploadedAttachmentRef } from '@shared/types';
import type { SdkSessionHandle } from '../types';

// mock settingsStore 让 helper 内部 settingsStore.get('resumeRecentMessagesCount') 返 30
// (plan resume-inject-raw-messages-20260601 §D5: autoSummariseOnFallback 已删，改无条件注入 +
//  resumeRecentMessagesCount 控制原始对话条数)
vi.mock('@main/store/settings-store', () => ({
  settingsStore: {
    get: vi.fn((key: string) => {
      if (key === 'resumeRecentMessagesCount') return 30;
      return undefined;
    }),
  },
}));

const emits: AgentEvent[] = [];

interface MakeCtxOpts {
  jsonlExistsReturn?: boolean | ((cwd: string, sid: string) => boolean);
  createSession?: (opts: unknown) => Promise<SdkSessionHandle>;
  summariseFnReturn?: string | null;
  listEventsFnReturn?: AgentEvent[];
  /** REVIEW_76 MED: 让 listEventsFn 抛错验证「永不抛错」契约（fresh fallback 仍走 createSession） */
  listEventsFnThrow?: Error;
  /** plan resume-inject §D5: message-only 返回（拼原始对话段）。默认空数组。 */
  listMessagesFnReturn?: (AgentEvent & { id: number })[];
}

function makeCtx(opts: MakeCtxOpts = {}): {
  ctx: JsonlFallbackCtx;
  jsonlExistsThunkSpy: ReturnType<typeof vi.fn>;
  createSessionSpy: ReturnType<typeof vi.fn>;
  summariseFnSpy: ReturnType<typeof vi.fn>;
} {
  const jsonlExistsThunkSpy = vi.fn(
    typeof opts.jsonlExistsReturn === 'function'
      ? opts.jsonlExistsReturn
      : (_cwd: string, _sid: string) =>
          opts.jsonlExistsReturn === undefined ? true : opts.jsonlExistsReturn,
  );
  const createSessionSpy = vi.fn(
    opts.createSession ??
      (async () => ({ sessionId: 'helper-stub-sid' }) as SdkSessionHandle),
  );
  const summariseFnSpy = vi.fn(async () => opts.summariseFnReturn ?? null);
  const ctx: JsonlFallbackCtx = {
    jsonlExistsThunk: jsonlExistsThunkSpy as unknown as JsonlFallbackCtx['jsonlExistsThunk'],
    createSession: createSessionSpy as unknown as JsonlFallbackCtx['createSession'],
    emit: (e) => emits.push(e),
    summariseFn: summariseFnSpy as unknown as JsonlFallbackCtx['summariseFn'],
    listEventsFn: opts.listEventsFnThrow
      ? () => {
          throw opts.listEventsFnThrow;
        }
      : () => opts.listEventsFnReturn ?? [],
    listMessagesFn: () => opts.listMessagesFnReturn ?? [],
  };
  return { ctx, jsonlExistsThunkSpy, createSessionSpy, summariseFnSpy };
}

function makeRecoverOpts(overrides: Partial<JsonlFallbackOpts> = {}): JsonlFallbackOpts {
  return {
    sessionId: 'app-sid-A',
    cliSessionId: 'cli-sid-X',
    cwd: '/tmp/test',
    prependCwd: '/tmp/test',
    prompt: '继续之前的话题',
    maxEventIdFn: () => null,
    emitContext: 'recover',
    cwdFellBack: false,
    ...(overrides as object),
  } as JsonlFallbackOpts;
}

function makeRestartOpts(overrides: Partial<JsonlFallbackOpts> = {}): JsonlFallbackOpts {
  return {
    sessionId: 'app-sid-R',
    cliSessionId: 'cli-sid-Y',
    cwd: '/tmp/test',
    prependCwd: '/tmp/test',
    prompt: '继续之前的会话',
    maxEventIdFn: () => null,
    emitContext: 'restart',
    cwdFellBack: false,
    restartLabel: '权限模式 plan',
    ...(overrides as object),
  } as JsonlFallbackOpts;
}

beforeEach(() => {
  emits.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('maybeJsonlFallback helper (plan §D5 测试矩阵)', () => {
  // ─────────────────────────────────────────────
  // T10: OR 短路 sub-case
  // ─────────────────────────────────────────────
  it('T10a: cwdFellBack=true → jsonlExistsThunk spy 不被调(短路求值 + fail-safe 不被绕过)', async () => {
    const { ctx, jsonlExistsThunkSpy } = makeCtx({ jsonlExistsReturn: true });
    await maybeJsonlFallback(ctx, makeRecoverOpts({ cwdFellBack: true }));
    expect(jsonlExistsThunkSpy).not.toHaveBeenCalled();
  });

  it('T10b: cwdFellBack=false → jsonlExistsThunk spy 被调一次', async () => {
    const { ctx, jsonlExistsThunkSpy } = makeCtx({ jsonlExistsReturn: true });
    await maybeJsonlFallback(ctx, makeRecoverOpts({ cwdFellBack: false }));
    expect(jsonlExistsThunkSpy).toHaveBeenCalledOnce();
  });

  // ─────────────────────────────────────────────
  // T4: D3 cli sid 维度找 jsonl
  // ─────────────────────────────────────────────
  it('T4: cliSessionId !== sessionId → jsonlExistsThunk 用 cliSessionId 找 jsonl', async () => {
    const { ctx, jsonlExistsThunkSpy } = makeCtx({ jsonlExistsReturn: true });
    await maybeJsonlFallback(
      ctx,
      makeRecoverOpts({
        sessionId: 'app-sid',
        cliSessionId: 'cli-sid-DIFFERENT',
        cwd: '/tmp/x',
      }),
    );
    expect(jsonlExistsThunkSpy).toHaveBeenCalledWith('/tmp/x', 'cli-sid-DIFFERENT');
  });

  it('T4-fallback: cliSessionId null → ?? sessionId 兜底用 sessionId 找 jsonl', async () => {
    const { ctx, jsonlExistsThunkSpy } = makeCtx({ jsonlExistsReturn: true });
    await maybeJsonlFallback(
      ctx,
      makeRecoverOpts({
        sessionId: 'app-sid-only',
        cliSessionId: null,
      }),
    );
    expect(jsonlExistsThunkSpy).toHaveBeenCalledWith('/tmp/test', 'app-sid-only');
  });

  // ─────────────────────────────────────────────
  // T2: jsonl 缺失 → fellBack=true 完整路径
  // ─────────────────────────────────────────────
  it('T2: jsonl 缺失 → fellBack=true,createSession 被调一次,emit 2 次,return finalSessionId === opts.sessionId', async () => {
    const { ctx, createSessionSpy } = makeCtx({ jsonlExistsReturn: false });
    const result = await maybeJsonlFallback(
      ctx,
      makeRecoverOpts({ sessionId: 'app-sid-fellback', cwd: '/tmp/fb' }),
    );
    expect(result.fellBack).toBe(true);
    expect(result.finalSessionId).toBe('app-sid-fellback'); // 不变量 3: applicationSid 全程不变
    expect(createSessionSpy).toHaveBeenCalledOnce();
    expect(emits).toHaveLength(2);
    expect(emits[0].kind).toBe('message');
    expect(emits[1].kind).toBe('message');
  });

  // ─────────────────────────────────────────────
  // T9: ctx.createSession opts 字段断言
  // ─────────────────────────────────────────────
  it('T9: createSession 被调 opts 字段 — resume === sessionId + resumeMode === fresh-cli-reuse-app + 不含 resumeCliSid (不变量 10)', async () => {
    const { ctx, createSessionSpy } = makeCtx({ jsonlExistsReturn: false });
    await maybeJsonlFallback(
      ctx,
      makeRecoverOpts({ sessionId: 'app-sid-X', cwd: '/tmp/x' }),
    );
    const opts = createSessionSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.resume).toBe('app-sid-X');
    expect(opts.resumeMode).toBe('fresh-cli-reuse-app');
    expect(opts).not.toHaveProperty('resumeCliSid'); // 不变量 10 硬约束
    expect(opts.cwd).toBe('/tmp/x');
  });

  // T9a/T9b/T9c: attachments 三 sub-case
  it('T9a: attachments undefined → emit role=user payload 不含 attachments 字段', async () => {
    const { ctx } = makeCtx({ jsonlExistsReturn: false });
    await maybeJsonlFallback(ctx, makeRecoverOpts({ prompt: 'hi', attachments: undefined }));
    const userMsg = emits.find(
      (e) => e.kind === 'message' && (e.payload as { role?: string }).role === 'user',
    );
    expect(userMsg).toBeDefined();
    expect(userMsg!.payload).not.toHaveProperty('attachments');
  });

  it('T9b: attachments 空数组 → emit role=user payload 不含 attachments 字段 (length > 0 spread 条件)', async () => {
    const { ctx } = makeCtx({ jsonlExistsReturn: false });
    await maybeJsonlFallback(ctx, makeRecoverOpts({ attachments: [] }));
    const userMsg = emits.find(
      (e) => e.kind === 'message' && (e.payload as { role?: string }).role === 'user',
    );
    expect(userMsg).toBeDefined();
    expect(userMsg!.payload).not.toHaveProperty('attachments');
  });

  it('T9c: attachments 非空数组 → emit role=user payload.attachments === opts.attachments (reference 透传)', async () => {
    const { ctx } = makeCtx({ jsonlExistsReturn: false });
    const refs: UploadedAttachmentRef[] = [
      { kind: 'uploaded', path: '/tmp/a.png', mime: 'image/png', bytes: 100 },
      { kind: 'uploaded', path: '/tmp/b.png', mime: 'image/png', bytes: 200 },
    ];
    await maybeJsonlFallback(ctx, makeRecoverOpts({ attachments: refs }));
    const userMsg = emits.find(
      (e) => e.kind === 'message' && (e.payload as { role?: string }).role === 'user',
    );
    expect(userMsg).toBeDefined();
    expect((userMsg!.payload as { attachments: unknown }).attachments).toBe(refs);
  });

  it('T9-extra: emit payload.text === opts.prompt (用户原 prompt 不是 prepend 后 summary prompt)', async () => {
    const { ctx } = makeCtx({
      jsonlExistsReturn: false,
      summariseFnReturn: 'fake summary',
      listEventsFnReturn: [{ sessionId: 's', agentId: 'a', kind: 'message', payload: { text: 'x' }, ts: 0, source: 'sdk' }],
    });
    await maybeJsonlFallback(ctx, makeRecoverOpts({ prompt: '用户实际发的话' }));
    const userMsg = emits.find(
      (e) => e.kind === 'message' && (e.payload as { role?: string }).role === 'user',
    );
    expect(userMsg).toBeDefined();
    expect((userMsg!.payload as { text: string }).text).toBe('用户实际发的话');
  });

  // ─────────────────────────────────────────────
  // T7: 摘要成功 vs 失败 — fellBack=true 路径
  // ─────────────────────────────────────────────
  it('T7-used: 摘要成功 (summaryResult.used=true) → emit fallback info 走 buildJsonlMissingSummaryUsedText', async () => {
    const { ctx } = makeCtx({
      jsonlExistsReturn: false,
      summariseFnReturn: '前情摘要内容',
      listEventsFnReturn: [{ sessionId: 's', agentId: 'a', kind: 'message', payload: { text: 'x' }, ts: 0, source: 'sdk' }],
      // plan resume-inject §D5: used=true 需有原始对话消息（raw 段是底线）
      listMessagesFnReturn: [{ id: 1, sessionId: 's', agentId: 'a', kind: 'message', payload: { role: 'user', text: '历史问题' }, ts: 0, source: 'sdk' }],
    });
    await maybeJsonlFallback(ctx, makeRecoverOpts({ cwd: '/tmp/x' }));
    expect(emits).toHaveLength(2);
    const infoText = (emits[0].payload as { text: string }).text;
    expect(infoText).toContain('LLM 摘要自动注入了历史上下文'); // buildJsonlMissingSummaryUsedText 标志短语
    expect(infoText).toContain('/tmp/x');
  });

  it('T7-skipped: 无历史 (listMessages 空,used=false) → emit 走 buildJsonlMissingSummarySkippedText', async () => {
    const { ctx } = makeCtx({
      jsonlExistsReturn: false,
      listEventsFnReturn: [], // 空 events → 总结段也空
      // listMessagesFnReturn 默认空 → injectResumeHistory no-history → used=false
    });
    await maybeJsonlFallback(ctx, makeRecoverOpts({ cwd: '/tmp/x' }));
    expect(emits).toHaveLength(2);
    const infoText = (emits[0].payload as { text: string }).text;
    expect(infoText).toContain('典型原因'); // buildJsonlMissingSummarySkippedText 标志短语
    expect(infoText).toContain('/tmp/x');
  });

  // ─────────────────────────────────────────────
  // T8: 6 文案矩阵 (recover × cwdFellBack 4 + restart × cwdFellBack=false 2)
  // ─────────────────────────────────────────────
  it('T8-1 recover × cwdFellBack=false × used=true → buildJsonlMissingSummaryUsedText', async () => {
    const { ctx } = makeCtx({
      jsonlExistsReturn: false,
      summariseFnReturn: '摘要',
      listEventsFnReturn: [{ sessionId: 's', agentId: 'a', kind: 'message', payload: { text: 'x' }, ts: 0, source: 'sdk' }],
      // plan resume-inject §D5: used=true 需有原始对话消息（raw 段是底线，仅总结无 raw → no-history）
      listMessagesFnReturn: [{ id: 1, sessionId: 's', agentId: 'a', kind: 'message', payload: { role: 'user', text: '历史问题' }, ts: 0, source: 'sdk' }],
    });
    await maybeJsonlFallback(ctx, makeRecoverOpts({ cwdFellBack: false, cwd: '/tmp/c1' }));
    expect((emits[0].payload as { text: string }).text).toContain('LLM 摘要自动注入');
    expect((emits[0].payload as { text: string }).text).toContain('/tmp/c1');
  });

  it('T8-2 recover × cwdFellBack=false × used=false → buildJsonlMissingSummarySkippedText', async () => {
    const { ctx } = makeCtx({ jsonlExistsReturn: false, listEventsFnReturn: [] });
    await maybeJsonlFallback(ctx, makeRecoverOpts({ cwdFellBack: false, cwd: '/tmp/c2' }));
    expect((emits[0].payload as { text: string }).text).toContain('典型原因');
    expect((emits[0].payload as { text: string }).text).toContain('/tmp/c2');
  });

  it('T8-3 recover × cwdFellBack=true × used=true → buildCwdFallbackSummaryUsedText (不含 cwd 字段)', async () => {
    const { ctx } = makeCtx({
      jsonlExistsReturn: true, // cwdFellBack=true 短路不调 jsonlExistsThunk
      summariseFnReturn: '摘要',
      listEventsFnReturn: [{ sessionId: 's', agentId: 'a', kind: 'message', payload: { text: 'x' }, ts: 0, source: 'sdk' }],
      listMessagesFnReturn: [{ id: 1, sessionId: 's', agentId: 'a', kind: 'message', payload: { role: 'user', text: '历史问题' }, ts: 0, source: 'sdk' }],
    });
    await maybeJsonlFallback(
      ctx,
      makeRecoverOpts({ cwdFellBack: true, cwd: '/tmp/fb', prependCwd: '/tmp/orig' }),
    );
    const txt = (emits[0].payload as { text: string }).text;
    expect(txt).toContain('Claude 应能在新 cwd 续上前情'); // buildCwdFallbackSummaryUsedText 标志
    expect(txt).not.toContain('/tmp/fb'); // 不重复 cwd (outer caller 已 emit cwd 切换 fact)
  });

  it('T8-4 recover × cwdFellBack=true × used=false → buildCwdFallbackSummarySkippedText', async () => {
    const { ctx } = makeCtx({ jsonlExistsReturn: true, listEventsFnReturn: [] });
    await maybeJsonlFallback(ctx, makeRecoverOpts({ cwdFellBack: true }));
    const txt = (emits[0].payload as { text: string }).text;
    expect(txt).toContain('原 cwd 编码下的 jsonl 在新 cwd 不可用'); // buildCwdFallbackSummarySkippedText 标志
  });

  it('T8-5 restart × cwdFellBack=false × used=true → buildRestartJsonlMissingSummaryUsedText (含 restartLabel)', async () => {
    const { ctx } = makeCtx({
      jsonlExistsReturn: false,
      summariseFnReturn: '摘要',
      listEventsFnReturn: [{ sessionId: 's', agentId: 'a', kind: 'message', payload: { text: 'x' }, ts: 0, source: 'sdk' }],
      listMessagesFnReturn: [{ id: 1, sessionId: 's', agentId: 'a', kind: 'message', payload: { role: 'user', text: '历史问题' }, ts: 0, source: 'sdk' }],
    });
    await maybeJsonlFallback(
      ctx,
      makeRestartOpts({ cwd: '/tmp/r1', restartLabel: '权限模式 acceptEdits' }),
    );
    const txt = (emits[0].payload as { text: string }).text;
    expect(txt).toContain('LLM 摘要自动注入');
    expect(txt).toContain('已切到 权限模式 acceptEdits');
    expect(txt).toContain('/tmp/r1');
  });

  it('T8-6 restart × cwdFellBack=false × used=false → buildRestartJsonlMissingSummarySkippedText (含 restartLabel)', async () => {
    const { ctx } = makeCtx({ jsonlExistsReturn: false, listEventsFnReturn: [] });
    await maybeJsonlFallback(
      ctx,
      makeRestartOpts({ cwd: '/tmp/r2', restartLabel: 'OS 沙盒 workspace-write' }),
    );
    const txt = (emits[0].payload as { text: string }).text;
    expect(txt).toContain('典型原因');
    expect(txt).toContain('已切到 OS 沙盒 workspace-write');
    expect(txt).toContain('/tmp/r2');
  });

  // ─────────────────────────────────────────────
  // T1 配套: jsonl 在 → fellBack=false 不调 createSession
  // ─────────────────────────────────────────────
  it('T1-helper: jsonl 在 → fellBack=false,createSession 不被调,emit 0 次,return finalSessionId === opts.sessionId', async () => {
    const { ctx, createSessionSpy } = makeCtx({ jsonlExistsReturn: true });
    const result = await maybeJsonlFallback(ctx, makeRecoverOpts({ sessionId: 'app-X' }));
    expect(result.fellBack).toBe(false);
    expect(result.finalSessionId).toBe('app-X');
    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(emits).toHaveLength(0);
  });

  // ─────────────────────────────────────────────
  // createSession 抛错 → helper rethrow,caller catch 块处理
  // ─────────────────────────────────────────────
  it('createSession 抛错 → helper rethrow,emit 仅 0 次 (fallback info 不 emit,因 emit 顺序契约 createSession 先)', async () => {
    const { ctx } = makeCtx({
      jsonlExistsReturn: false,
      createSession: async () => {
        throw new Error('SDK 启动失败');
      },
    });
    await expect(maybeJsonlFallback(ctx, makeRecoverOpts())).rejects.toThrow('SDK 启动失败');
    expect(emits).toHaveLength(0); // R5 双方共识 emit 顺序: createSession 先 / emit 后 — createSession 抛错时 emit 不发,caller catch 块 emit error
  });

  // ─────────────────────────────────────────────
  // REVIEW_76 MED: listEventsFn throw 不阻断 fresh fallback（「永不抛错」契约）
  // ─────────────────────────────────────────────
  it('REVIEW_76 MED: listEventsFn 抛错 → 不传播,fresh fallback 仍调 createSession（永不抛错契约）', async () => {
    // 模拟 eventRepo.listForSession 内部 rowToEvent JSON.parse 损坏 payload 抛错
    const { ctx, createSessionSpy } = makeCtx({
      jsonlExistsReturn: false, // jsonl 缺失 → 走 fresh fallback
      listEventsFnThrow: new Error('JSON.parse: corrupt payload_json (simulated)'),
    });

    // 修前：listEventsFn 在 prependHistorySummary try 外抛错 → 穿透 maybeJsonlFallback →
    // 在 createSession 之前中断 → recoverer 只 emit「自动恢复失败」不进 fresh CLI fallback。
    // 修后：listEventsFn 纳入 try/catch → thunk-throw failReason → fall back to originalText →
    // 仍调 createSession 起 fresh CLI thread（fellBack=true）。
    const result = await maybeJsonlFallback(ctx, makeRecoverOpts({ cwd: '/tmp/corrupt' }));

    // **MED-2 核心断言**：helper 不抛错 + fellBack=true + createSession 仍被调（fresh CLI 起来）
    expect(result.fellBack).toBe(true);
    expect(createSessionSpy).toHaveBeenCalledOnce();
    // createSession 用 originalText（摘要 prepend 跳过，因 listEventsFn 抛错走 thunk-throw）
    expect(createSessionSpy.mock.calls[0][0]).toMatchObject({
      prompt: '继续之前的话题', // makeRecoverOpts 默认 prompt（未被摘要 prepend）
      resumeMode: 'fresh-cli-reuse-app',
    });
  });

  // ─────────────────────────────────────────────
  // R2 reviewer-codex HIGH + reviewer-claude 反驳轮证实: close-during-summary-await abort
  // ─────────────────────────────────────────────
  it('R2 HIGH: isCancelledFn 在 summary await 后返 true（用户 close）→ abort 不调 createSession（aborted:true）', async () => {
    // 模拟用户在 injectResumeHistory（summariseFn await）期间主动 close：
    // summariseFn 是 async（让出事件循环），其间把 cancelled flag 翻 true 模拟 closeImpl 设 closed。
    let cancelled = false;
    const { ctx, createSessionSpy } = makeCtx({
      jsonlExistsReturn: false, // jsonl 缺失 → 走 fallback
      listMessagesFnReturn: [
        { id: 1, sessionId: 's', agentId: '', kind: 'message', payload: { role: 'user', text: '历史' }, ts: 1, source: 'sdk' },
      ],
    });
    // 覆写 summariseFn 让它在 await 期间翻 cancelled（模拟用户 close 落在 LLM await 窗口）
    ctx.summariseFn = (async () => {
      cancelled = true; // closeImpl setLifecycle('closed') 发生在 await 中途
      return '总结';
    }) as unknown as JsonlFallbackCtx['summariseFn'];

    const result = await maybeJsonlFallback(
      ctx,
      makeRecoverOpts({ isCancelledFn: () => cancelled }),
    );

    // 修后：await 后重读 isCancelledFn → true → abort 不起 fresh CLI
    expect(result.aborted).toBe(true);
    expect(result.fellBack).toBe(false);
    expect(createSessionSpy).not.toHaveBeenCalled(); // 关键：不起 fresh CLI（否则 ensure 复活 closed）
    // abort 时不 emit fallback info（避免 close 后又冒「恢复成功」矛盾文案）
    expect(emits.filter((e) => e.kind === 'message')).toHaveLength(0);
  });

  it('R2 HIGH: isCancelledFn 返 false（未 close）→ 正常 fallback 起 fresh CLI', async () => {
    const { ctx, createSessionSpy } = makeCtx({
      jsonlExistsReturn: false,
      summariseFnReturn: '总结',
      listMessagesFnReturn: [
        { id: 1, sessionId: 's', agentId: '', kind: 'message', payload: { role: 'user', text: '历史' }, ts: 1, source: 'sdk' },
      ],
    });
    const result = await maybeJsonlFallback(
      ctx,
      makeRecoverOpts({ isCancelledFn: () => false }),
    );
    expect(result.aborted).toBeUndefined();
    expect(result.fellBack).toBe(true);
    expect(createSessionSpy).toHaveBeenCalledOnce(); // 未 close → 正常起 fresh
  });

  it('R2 HIGH: restart 路径不传 isCancelledFn → 不 gate（即使 lifecycle 过渡态 closed 也正常 fallback）', async () => {
    // restart 本就「先 close 再 cold restart」，过渡态 closed 是预期，不能被 abort 拦
    const { ctx, createSessionSpy } = makeCtx({
      jsonlExistsReturn: false,
      summariseFnReturn: '总结',
      listMessagesFnReturn: [
        { id: 1, sessionId: 's', agentId: '', kind: 'message', payload: { role: 'user', text: '历史' }, ts: 1, source: 'sdk' },
      ],
    });
    // makeRestartOpts 不传 isCancelledFn（undefined）→ helper 不 gate
    const result = await maybeJsonlFallback(ctx, makeRestartOpts());
    expect(result.aborted).toBeUndefined();
    expect(result.fellBack).toBe(true);
    expect(createSessionSpy).toHaveBeenCalledOnce(); // restart 正常起，不被 closed gate 拦
  });
});
