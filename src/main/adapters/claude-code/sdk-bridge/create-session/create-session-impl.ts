/**
 * createSession orchestrator — Step 4.4 拆分子模块。
 *
 * **抽出范围**（原 index.ts:189-544 ~356 LOC 拆完后剩 orchestrator 部分）：
 * - validate phase（inline ~5 LOC，user mini-spike Q2 confirm 推荐方案）
 * - prepare phase（tempKey + releasePending + claimAsSdk(opts.resume) + makeInternalSession +
 *   pendingUserMessages push + userMessageIterable + canUseTool 装配）
 * - dispatch sdk-query phase（runCreateSessionSdkQuery 子模块）
 * - finalize phase（finalizeSessionStart 调用，含 fresh-cli-reuse-app skip 分支）
 * - return SdkSessionHandle
 *
 * **签名 / 约束**：
 * - 入参：opts（CreateSessionOpts）+ deps（CreateSessionDeps facade ref bundle）
 * - 返回：Promise<SdkSessionHandle>
 * - throw 路径完整透传（sdk-query 内已完整 cleanup，orchestrator 不重复 cleanup）
 * - 不变量保留：plan reverse-rename-sid-stability §A.4-pre S2/S5 / restart-controller-jsonl-precheck §3a.5 /
 *   handoff-render-and-image-batch §Phase 2 Step 2.2 字面 carry over
 *
 * **抽出动机**：与 codex 端 create-session/create-session-impl.ts 同款 orchestrator 模式
 * （free fn dispatch validate / prepare / sdk-query / finalize 三阶段）。让 facade
 * `index.ts` createSession 改 thin delegate ~10 LOC（CreateSessionDeps 装配 + 调
 * createSessionImpl）。
 */
import { randomUUID } from 'node:crypto';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { makeCanUseTool } from '../can-use-tool';
import { makeInternalSession, type InternalSession } from '../types';
import { resolveClaudeSandboxMode } from '../sandbox-resolve';
import { resolveClaudeModel } from '../model-resolve';
import { finalizeSessionStart } from '../session-finalize';
import { runCreateSessionSdkQuery } from './create-session-sdk-query';
import { isClaudeThinkingLevel } from '@shared/session-metadata';
import type {
  CreateSessionDeps,
  CreateSessionOpts,
  PreparedSessionContext,
  SdkSessionHandle,
} from './_deps';

function emitVisibleCreateFailure(
  deps: CreateSessionDeps,
  internal: InternalSession,
  err: unknown,
): void {
  const sessionId = internal.applicationSid;
  const record = sessionRepo.get(sessionId);
  if (!record || record.lifecycle === 'closed') return;

  if (!internal.expectedClose) {
    deps.emit({
      sessionId,
      agentId: 'claude-code',
      kind: 'message',
      payload: {
        text: `⚠ Claude SDK 启动失败：${(err as Error)?.message ?? String(err)}`,
        error: true,
      },
      ts: Date.now(),
      source: 'sdk',
    });
  }
  deps.emit({
    sessionId,
    agentId: 'claude-code',
    kind: 'finished',
    payload: { ok: false, subtype: 'error' },
    ts: Date.now(),
    source: 'sdk',
  });
}

/**
 * createSession 主入口实现 — free fn，无 facade class 内部 state。
 *
 * @param opts caller 原入参
 * @param deps facade ref bundle（sessions Map / emit / streamProcessor / responder /
 *             getPermissionTimeoutMs / interrupt thunk）
 * @returns Promise<SdkSessionHandle> { sessionId, abort }
 */
export async function createSessionImpl(
  opts: CreateSessionOpts,
  deps: CreateSessionDeps,
): Promise<SdkSessionHandle> {
  // === phase 1: validate ===
  // SDK streaming 协议硬性约束：必须有首条 user message 才会启动 CLI 子进程，
  // 否则 stdin 永远等不到数据 → CLI 不动 → SDK 不发 SDKMessage → 30s 兜底超时。
  // UI 已强制必填，这里再守一道，避免 IPC 直调时静默卡死。
  if (!opts.prompt || !opts.prompt.trim()) {
    throw new Error('首条消息不能为空：SDK streaming 模式需要首条消息才能启动 CLI');
  }

  // === phase 2: prepare ===
  // R3.E6：删除老 Claude Code experimental teams flag 相关 resume + teamName warn —— teamName
  // 现在仅作 universal team 抽象的入口标签，与 Claude CLI 实验特性无关，无 resume race。
  const tempKey = randomUUID();
  // 时序保护：CLI 子进程内部 hook 可能先于 SDK 通道首条 SDKMessage 到达，
  // 提前注册 cwd「待领取」标记，让 sessionManager 把首发的同 cwd hook 事件
  // 自动归到 SDK，避免出现「内/外」两份重复会话。
  //
  // 注意：releasePending 必须在「成功 + 失败」两条路径都释放，否则失败时
  // pending cwd 会卡 60s ttl，期间同 cwd 的真实外部 hook 会话被误吞。
  // **REVIEW_75 MED (reviewer-claude + lead grep/diff 实测)**:orchestrator prepare→finalize
  // 整段用 try/catch 包(下方 try)。修前本函数零 try(仅 runCreateSessionSdkQuery 子模块内部
  // 自带 try),prepare 段 resolver(L下方 resolveClaudeSandboxMode / resolveClaudeModel 走
  // sessionRepo.get + settingsStore.get,better-sqlite3 同步 .get() SQLITE_BUSY/corrupt 可抛)
  // 抛错 → 异常直冒 caller → releasePending() + releaseSdkClaim(opts.resume) 都到不了 →
  // (a) pendingSdkCwds 卡 60s 误吞同 cwd 外部 hook 会话(CHANGELOG_47 修过)(b) resume 路径
  // opts.resume 永留 sdkOwned 静默吞后续 hook(REVIEW_5 H4 修过)。diff a21f258~1 确认原单体
  // createSession 也是 resolver 在 try 外 → 既有潜伏 gap 非本次拆分回归。catch 与
  // runCreateSessionSdkQuery 子模块 catch 同款幂等清理(子模块 throw 路径会被本 catch 再跑一遍,
  // 全部 no-op-safe:releasePending 内部 identity check / releaseSdkClaim Set.delete / Map.delete /
  // sessionRepo.delete(tempKey) DELETE 命中 0 行均无害)。
  const releasePending = sessionManager.expectSdkSession(opts.cwd);
  let internalForCleanup: InternalSession | null = null;

  try {
    // REVIEW_5 H4：resume 路径下 cwd 待领取兜底**失效**（dedupOrClaim 第二道仅对
    // `!sessionRepo.get(id)` 起作用，OLD_ID 在历史 DB 里一定存在），CLI 内部 hook 抢先
    // 上报 SessionStart 时会直接 ensure→revive 出一条 cli source 的 active record，
    // 与稍后 SDK 30s fallback 用 tempKey 又造的另一条 active record 在 SessionList
    // 显示成「两条 active 看起来一样的会话」（用户报项 + 双对抗 ✅）。
    //
    // 修法：进入即把 opts.resume 提前 claim 到 sdkOwned，hook 进 ingest 时
    // 第一道防线 `sdkOwned.has(event.sessionId)` 直接 skip。配合下方 fallback 用
    // opts.resume 作 sessionId 不再造 tempKey 占位行，根治两条 active record。
    if (opts.resume) {
      sessionManager.claimAsSdk(opts.resume);
    }
    // CHANGELOG_85 Step 3.2：InternalSession 字段初值集中到 types.ts:makeInternalSession factory
    // （permissionMode 与 query options 同源 `opts.permissionMode ?? 'default'`，详
    // makeInternalSession + InternalSession.permissionMode 字段 jsdoc）。
    // plan reverse-rename-sid-stability-20260520 §A.4-pre S2: applicationSid 双阶段化:
    // - spawn 主路径(无 opts.resume): ctor 时 = tempKey,first realId 到达时 stream-processor.ts:271
    //   isNewSpawn 分支保护切到 realId 后冻结
    // - resume / fallback 路径(有 opts.resume): ctor 时 = opts.resume,全生命周期不变
    const internal = makeInternalSession({
      cwd: opts.cwd,
      permissionMode: opts.permissionMode,
      applicationSid: opts.resume ?? tempKey,
    });
    internalForCleanup = internal;

    if (opts.prompt) {
      // 用 tempKey 占位 session_id，实际 SDK 会忽略这个字段（用自己的）
      internal.pendingUserMessages.push(
        deps.streamProcessor.makeUserMessage(tempKey, opts.prompt, opts.attachments),
      );
    }

    const userMessageIterable = deps.streamProcessor.createUserMessageStream(internal, tempKey);

    // 鉴权 / 模型映射 / 代理地址等都来自 ~/.claude/settings.json 的 env 字段，
    // 由 main bootstrap 阶段的 applyClaudeSettingsEnv() 注入到 process.env，
    // SDK spawn 的 CLI 子进程会继承，与终端 `claude` 用同一套配置。

    // CHANGELOG_52 Step 3c：canUseTool 巨型 callback (~275 行) 抽到 sdk-bridge/can-use-tool.ts。
    // class state 通过 deps 注入（internal / sessionId getter / emit / 超时阈值 / responder ref）。
    // 护栏（READ_ONLY 白名单 / SandboxNetworkAccess auto-deny / approve+plan deny+message
    // / approve-bypass deny+interrupt / 超时 timer + abort listener）全部完整保留在 module。
    const canUseTool = makeCanUseTool({
      internal,
      // **plan reverse-rename-sid-stability-20260520 §A.4-pre S4b R4 HIGH-H 修订**:
      // canUseTool getSessionId 返 internal.applicationSid (替代 internal.realSessionId ?? tempKey) —
      // can-use-tool.ts:139/219/349 多处 emit waiting-for-user event 用此 sid,renderer SessionDetail
      // 路由必须用 applicationSid 才能命中 PendingTab 不漂浮 (D7 不变量 3 wire prefix [sid] 100%
      // 写 sessions.id);spawn 主路径 ctor 时 applicationSid = tempKey,first realId 后切到 realId
      // 冻结 (S2 jsdoc)。
      getSessionId: () => internal.applicationSid,
      // CHANGELOG_72 Bug 3：bypass 短路读 internal.permissionMode（与 SDK options 同源），
      // 不查 sessionRepo —— 避免 createSession 期间 sessionRepo 还没记录 permission_mode 的 race。
      getPermissionMode: () => internal.permissionMode,
      emit: deps.emit,
      getPermissionTimeoutMs: deps.getPermissionTimeoutMs,
      responder: deps.responder,
    });

    // CHANGELOG_85 Step 3.2：sandbox mode fallback 链抽到 sandbox-resolve.ts。
    // 提到 try 块外，让 emit session-start 之后的 setClaudeCodeSandbox 持久化用同一变量。
    const claudeSandboxMode = resolveClaudeSandboxMode(opts);
    // plan model-wiring-and-handoff-20260514 Step 2.2：model fallback 链抽到 model-resolve.ts。
    // 提到 try 块外让 finalizeSessionStart 持久化用同一变量（与 sandbox 同模式）。
    const claudeModel = resolveClaudeModel(opts);
    const persistedThinking = opts.resume ? sessionRepo.get(opts.resume)?.thinking : null;
    const claudeCodeEffortLevel =
      opts.claudeCodeEffortLevel ??
      (isClaudeThinkingLevel(persistedThinking) ? persistedThinking : undefined);
    const effectiveOpts =
      claudeCodeEffortLevel === opts.claudeCodeEffortLevel
        ? opts
        : { ...opts, claudeCodeEffortLevel };

    // === phase 3: sdk-query (含 try/catch 失败 cleanup) ===
    const ctx: PreparedSessionContext = {
      tempKey,
      releasePending,
      internal,
      userMessageIterable,
      canUseTool,
      claudeSandboxMode,
      claudeModel,
      initialSessionEmitted: !opts.resume && opts.awaitCanonicalId !== true,
    };
    if (ctx.initialSessionEmitted) {
      deps.sessions.set(internal.applicationSid, internal);
      sessionManager.claimAsSdk(internal.applicationSid);
      finalizeSessionStart({
        applicationSid: internal.applicationSid,
        cwd: opts.cwd,
        prompt: opts.prompt,
        claudeSandboxMode,
        claudeModel,
        claudeCodeEffortLevel,
        extraAllowWrite: opts.extraAllowWrite,
        attachments: opts.attachments,
        handOff: opts.handOff,
        emit: deps.emit,
      });

      const startInBackground = async (): Promise<void> => {
        try {
          const { realId } = await runCreateSessionSdkQuery(effectiveOpts, ctx, deps);
          releasePending();
          if (internal.expectedClose || deps.sessions.get(internal.applicationSid) !== internal) {
            return;
          }
          finalizeSessionStart({
            applicationSid: internal.applicationSid,
            cliSessionId: realId,
            cwd: opts.cwd,
            prompt: opts.prompt,
            claudeSandboxMode,
            claudeModel,
            claudeCodeEffortLevel,
            extraAllowWrite: opts.extraAllowWrite,
            attachments: opts.attachments,
            handOff: opts.handOff,
            skipSessionStartEmit: true,
            skipFirstUserEmit: true,
            emit: deps.emit,
          });
        } catch (err) {
          emitVisibleCreateFailure(deps, internal, err);
        }
      };

      setTimeout(() => {
        if (internal.expectedClose || deps.sessions.get(internal.applicationSid) !== internal) {
          releasePending();
          return;
        }
        void startInBackground();
      }, 0);

      return {
        sessionId: internal.applicationSid,
        abort: () => void deps.interrupt(internal.applicationSid),
      };
    }

    const { realId } = await runCreateSessionSdkQuery(effectiveOpts, ctx, deps);

    // 真实 id 已经入手，cwd 待领取标记可以释放（如果 hook 已经先消费过则是 no-op）
    releasePending();

    // === phase 4: finalize ===
    // CHANGELOG_85 Step 3.2：emit session-start + 持久化 sandbox + 补 emit 首条 prompt
    // 三段固定 finalize 链抽到 session-finalize.ts。
    // plan cross-adapter-parity-20260515 Phase A Step A.5: extraAllowWrite 同 claudeModel
    // 同款持久化(spawn-time 透传给 finalizeSessionStart → setExtraAllowWrite 写库),让
    // recoverer fallback / resume 路径读回交还 SDK sandbox.allowWrite。
    // **plan reverse-rename-sid-stability-20260520 §A.4-pre S9 R3 HIGH-F + R6 MED-R6-1 修订**:
    // applicationSid + cliSessionId 双入参 — spawn 主路径下 internal.applicationSid 已切到
    // realId 后冻结 (S3 isNewSpawn 修订),emit session-start { sessionId: applicationSid }
    // 与现有 emit session-start { sessionId: realId } 行为字面等价 (S9 jsdoc)。
    //
    // **plan restart-controller-jsonl-precheck-20260521 §Step 3a.5 修法**:
    // resumeMode='fresh-cli-reuse-app' 路径 (jsonl-missing fallback via maybeJsonlFallback helper)
    // **跳过整段 finalize 链** — 该路径复用 applicationSid 行 (不创建新 sessions row),
    // emit session-start 会撞唯一索引 / 创建假 record;setClaudeCodeSandbox / setModel /
    // setExtraAllowWrite 已由 helper caller (restart-controller / recoverer) 之前显式写过 DB;
    // 首条 user message emit 由 helper 在 ctx.createSession 成功后补回 (不变量 11)。
    // fresh fallback 仅依赖 stream-processor S3 isNewSpawn 三分支内部 sessionManager.updateCliSessionId
    // 单点 UPDATE cli_session_id 列 (不变量 9 + session-finalize.ts:31/41/74 jsdoc 契约对齐)。
    //
    // **plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.2 第 8 步 + Phase 3 合并修法**:
    // attachments + handOff 字段透传给 finalize 链让首条 user message emit 时 spread 进 events.payload
    // (Phase 3 createSession 带图修 + Phase 2 cold-start prompt 特殊渲染)。fresh-cli-reuse-app 路径
    // 跳过 finalize 不影响 — helper 复 emit user message 时若需要 handOff 由 helper 自带(本 plan 修
    // 法仅覆盖 spawn 主路径,jsonl-missing fallback 路径不在范围)。
    if (opts.resumeMode !== 'fresh-cli-reuse-app') {
      finalizeSessionStart({
        applicationSid: internal.applicationSid,
        cliSessionId: realId,
        cwd: opts.cwd,
        prompt: opts.prompt,
        claudeSandboxMode,
        claudeModel,
        claudeCodeEffortLevel,
        extraAllowWrite: opts.extraAllowWrite,
        attachments: opts.attachments,
        handOff: opts.handOff,
        // REVIEW_58 HIGH ✅ 收口修法:recoverer.recoverAndSend 入口已 emit user message 时
        // 显式传 true,finalize 跳过重复 emit(详 createSession opts.skipFirstUserEmit jsdoc)。
        skipFirstUserEmit: opts.skipFirstUserEmit,
        emit: deps.emit,
      });
    }

    // **plan reverse-rename-sid-stability-20260520 §A.4-pre S5 R3 HIGH-F jsdoc 等价性注明**:
    // return handle.sessionId 用 internal.applicationSid (替代旧 return { sessionId: realId })。
    // spawn 主路径下 applicationSid 已在 S3 first realId 到达时切到 realId 后冻结,与现有
    // return { sessionId: realId } 字面行为等价 — caller 拿到的就是 first realId。
    // resume / fallback 路径下 applicationSid = caller 传入 opts.resume 全程不变。
    return {
      sessionId: internal.applicationSid,
      abort: () => void deps.interrupt(internal.applicationSid),
    };
  } catch (err) {
    // **REVIEW_75 MED (reviewer-claude)**:orchestrator prepare→finalize 段失败兜底清理。
    // 覆盖三类 throw:① prepare 段 resolver throw(runCreateSessionSdkQuery 之前,子模块 catch
    // 跑不到)② sdk-query 子模块 throw 后 rethrow(子模块 catch 已清一遍,此处幂等再跑无害)
    // ③ finalize 段 throw(sdk-query 已成功 + releasePending 已调,但 finalizeSessionStart 抛错)。
    // 全部清理操作幂等 no-op-safe:releasePending 内部 expiresAt identity check / releaseSdkClaim
    // Set.delete / sessionRepo.delete(tempKey) DELETE 命中 0 行。**只删 tempKey 不删
    // applicationSid/opts.resume**(防误删 resume 合法历史,与 sdk-query catch 同款安全边界:
    // spawn 路径孤儿 row id===tempKey;resume 路径 opts.resume 是预先存在合法 row 不能删)。
    releasePending();
    if (opts.resume) sessionManager.releaseSdkClaim(opts.resume);
    if (internalForCleanup && deps.sessions.get(tempKey) === internalForCleanup) {
      deps.sessions.delete(tempKey);
    }
    try {
      sessionRepo.delete(tempKey);
    } catch {
      // 孤儿 row 清理 best-effort,失败不掩盖原 err
    }
    throw err;
  }
}
