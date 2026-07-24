/**
 * createSession SDK query 段 — Step 4.4 拆分子模块。
 *
 * **抽出范围**（原 index.ts:344-489 ~146 LOC）：
 * - loadSdk / resolveClaudeBinary / buildSandboxOptions / buildMcpServersForSession
 * - effectiveResumeCliSid 三分支 guard 计算
 * - buildClaudeQueryOptions / query() 构造
 * - sessions.set / waitForRealSessionId / claimAsSdk(realId)
 * - try/catch fail 路径完整 cleanup（interrupt + sessions.delete × 2 + releasePending +
 *   releaseSdkClaim + throw）
 *
 * **签名 / 约束**：
 * - 入参：opts（caller 原入参）+ ctx（prepare phase 派生 state，PreparedSessionContext）
 *   + deps（facade ref bundle，CreateSessionDeps）
 * - 返回：成功 → SdkQueryResult { realId }；失败 → throw（catch 内已完整 cleanup）
 * - 不动 `internal.applicationSid` 切换语义：spawn 主路径 first realId 到达时 stream-processor.ts:271
 *   isNewSpawn 分支保护切换；resume 路径 ctor 时已 = opts.resume 全生命周期不变
 *
 * **不变量保留**（plan reverse-rename-sid-stability-20260520 §A.4-pre S1/S2/S3/S6.5/S9）：
 * - S2: spawn 主路径 internal.applicationSid 初值 = tempKey
 * - S3: sessions Map key = internal.applicationSid（spawn 主路径 = tempKey；resume 路径 = opts.resume）
 * - S6.5: effectiveResumeCliSid 三分支 guard 不 short-circuit
 * - REVIEW_60 R2 HIGH-1: catch 块 delete 双 key（applicationSid + tempKey）防 stale Map entry
 * - A1-HIGH-1: realId === tempKey 表示 consume 自吞错，throw 让 catch 走完整 cleanup
 * - REVIEW_5 H4: failure 路径必须 releaseSdkClaim(opts.resume)
 *
 * **抽出动机**：与 codex 端 create-session/create-session-resume.ts / -new.ts 同款拆分粒度；
 * 但 claude 端 SDK query 段无 resume/new 分支（统一一段 try），所以 inline validate（30 LOC）
 * + 抽 sdk-query 一段已足够（user mini-spike Q2 confirm 推荐方案）。
 */
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { getSdkRuntimeOptions } from '@main/adapters/claude-code/sdk-runtime';
import { resolveClaudeBinary } from '@main/adapters/claude-code/resolve-claude-binary';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import {
  getAgentDeckPluginsForSession,
  getAgentDeckSystemPromptAppend,
} from '@main/adapters/claude-code/sdk-injection';
import { buildSandboxOptions } from '@main/adapters/claude-code/sandbox-config';
import { buildMcpServersForSession } from '../mcp-server-init';
import { buildClaudeQueryOptions } from '../query-options-builder';
import { buildClaudeRuntimeMetadataHooks } from '../runtime-metadata-sync';
import { RecoveryCancelledError } from '@main/adapters/shared/recovery-cancelled';
import type {
  CreateSessionDeps,
  CreateSessionOpts,
  PreparedSessionContext,
  SdkQueryResult,
} from './_deps';
import log from '@main/utils/logger';

const logger = log.scope('claude-sdk-query');

/**
 * createSession SDK query 段实现 — free fn，无 facade class 内部 state。
 *
 * @param opts caller 原入参（透传到 buildClaudeQueryOptions / waitForRealSessionId）
 * @param ctx prepare phase 派生 state（tempKey / internal / userMessageIterable / canUseTool /
 *            claudeSandboxMode / claudeModel / releasePending）
 * @param deps facade ref bundle（sessions Map / emit / streamProcessor 用）
 * @returns Promise<SdkQueryResult> 成功 = { realId }；失败 throw（catch 已 cleanup）
 */
export async function runCreateSessionSdkQuery(
  opts: CreateSessionOpts,
  ctx: PreparedSessionContext,
  deps: CreateSessionDeps,
): Promise<SdkQueryResult> {
  const { tempKey, releasePending, internal, userMessageIterable, canUseTool, claudeSandboxMode, claudeModel } = ctx;

  // 整段 await 链（loadSdk → query 构造 → waitForRealSessionId）任一步抛错都要
  // 释放 pending cwd 标记 + 清掉 sessions map 的 tempKey。CHANGELOG_47 修：
  // 之前 releasePending 只在成功路径调，失败时 60s ttl 内同 cwd 真实外部 hook 会话被误吞。
  let realId: string;
  try {
    const { query } = await loadSdk();
    const runtime = getSdkRuntimeOptions();
    // plan add-claude-cli-path-override-and-bump-sdks-20260520 §设计决策 D1 + §不变量 N5
    // + Follow-up F2+F3 抽 helper(plan §D5 + §D7 deviation):resolveClaudeBinary 内含
    // user override priority chain + existsSync 护栏 + bundled fallback;让 follow-up 单测
    // 不依赖 sdk-bridge 全 mock boilerplate(详 resolve-claude-binary.ts 抽出动机)。
    const claudeBinary = resolveClaudeBinary();
    // REVIEW_14 阶段 2 排查盲点：sandbox 是否生效在 SDK / OS 层不打 log，应用主进程
    // 看不到「sandbox 装载成功 / 失败」信号；改回顶层 sandbox 字段后此 log 帮助
    // 实证「buildSandboxOptions 真的传了对应配置进 SDK options」，下次问题排查少绕一圈。
    const sandboxOpts = buildSandboxOptions(claudeSandboxMode, opts.cwd, opts.extraAllowWrite);
    logger.info(
      `[sandbox] mode=${claudeSandboxMode} → ${
        sandboxOpts.sandbox ? 'enabled (top-level)' : 'disabled (no field)'
      }${
        opts.extraAllowWrite && opts.extraAllowWrite.length > 0
          ? ` extraAllowWrite=[${opts.extraAllowWrite.join(', ')}]`
          : ''
      }`,
    );
    // CHANGELOG_85 Step 3.2：mcp server 拼装抽到 mcp-server-init.ts
    // （plan task-mcp-merge-into-agent-deck-mcp-20260521 合并后单 server，task tools 跟随
    // settings.enableAgentDeckMcp toggle；smart migration 守护老用户 enableTaskManager:true 不丢失能力）
    const mcpServers = await buildMcpServersForSession(internal, deps.adapterId);

    // **REVIEW_99 R3 cancellation-epoch MED 修法 (post-guard 窗口收口)**:
    // loadSdk / buildMcpServersForSession 是 createSession 内部最后两个 pre-registration await。
    // recover 路径若用户在这段 await 窗口内主动 close → cancelCheck 返 true(close-epoch 变 /
    // record 删)。在 query() 启动 CLI 子进程 + sessions.set 注册 **之前** throw RecoveryCancelledError
    // sentinel abort:① 不起 fresh CLI(按次计费)② 不 sessions.set 污染 Map ③ 首条 SDK 事件不会
    // 过 ensure closed→active 复活反转用户显式 close。sentinel 由 recoverer outer catch / waiter
    // special-case 静默 abort(不 emit「自动恢复失败」)。query() 同步无 await,sessions.set 紧随其后
    // 同步执行 → JS 单线程下本 guard 到 sessions.set 之间 close 插不进来(无二次 TOCTOU,与 helper
    // await-后-createSession-前同步窗口同款论证)。**caller 不传 cancelCheck(spawn / IPC / restart)
    // → 不 gate(undefined?.() === undefined falsy)**。
    if (opts.cancelCheck?.()) {
      throw new RecoveryCancelledError(opts.resume ?? tempKey);
    }
    if (ctx.initialSessionEmitted && (internal.expectedClose || deps.sessions.get(internal.applicationSid) !== internal)) {
      throw new RecoveryCancelledError(internal.applicationSid);
    }

    // **plan reverse-rename-sid-stability-20260520 §A.4-pre S1 R6 HIGH-R6-1 + R7 HIGH-R7-1
    // bridge 内部 effectiveResumeCliSid 集中兜底**:
    // 三分支显式 guard opts.resume 防 spawn 主路径走 sessionRepo.get(undefined):
    // - fresh-cli-reuse-app fallback: SDK 不带 resume 起 fresh CLI thread → undefined
    // - spawn 主路径(无 opts.resume): undefined (SDK options.resume 不传)
    // - normal resume: opts.resumeCliSid 显式优先 / 不传时反查 sessionRepo.cliSessionId 兜底回填
    // **R8 LOW-R8-1**: assertCreateOptsValid runtime guard 应在 effective resolver **之前**跑
    // (fail-fast 原则,未实装,本 sub-commit A-4 仅落 effective 集中处理点,guard 留实施期补)。
    const effectiveResumeCliSid =
      opts.resumeMode === 'fresh-cli-reuse-app' ? undefined :
      !opts.resume ? undefined :
      (opts.resumeCliSid ?? sessionRepo.get(opts.resume)?.cliSessionId ?? opts.resume);

    const q = query({
      prompt: userMessageIterable,
      // CHANGELOG_85 Step 3.2：query() options 整段抽到 query-options-builder.ts
      // （pure builder，所有外部依赖通过 args 显式注入，零 side effect）
      options: buildClaudeQueryOptions({
        cwd: opts.cwd,
        permissionMode: opts.permissionMode,
        // **R6 HIGH-R6-1 修订**: SDK options.resume 字段用 effectiveResumeCliSid (cli sid 维度,
        // fresh fallback 时 undefined 让 SDK 不带 resume 起 fresh CLI thread,正常 resume 时
        // 反查 sessionRepo.cliSessionId 兜底回填 — 替代旧 opts.resume 字面 = applicationSid 维度,
        // 反向 rename 后 appSid != cliSid 时让 CLI 找正确 jsonl 文件)。
        resume: effectiveResumeCliSid,
        canUseTool,
        sandboxOpts,
        systemPromptAppend: getAgentDeckSystemPromptAppend(),
        plugins: getAgentDeckPluginsForSession(),
        runtime,
        claudeBinary,
        mcpServers,
        model: claudeModel,
        settingsPath: opts.settingsPath,
        effort: opts.claudeCodeEffortLevel,
        agentName: opts.claudeAgentName,
        agents: opts.claudeAgents,
        hooks: buildClaudeRuntimeMetadataHooks(internal),
      }),
    });
    internal.query = q;
    // **plan reverse-rename-sid-stability-20260520 §A.4-pre S3 ctor sessions Map key 修正**:
    // sessions Map key = internal.applicationSid (S2 ctor 时已 = opts.resume ?? tempKey)。
    // - spawn 主路径(无 opts.resume): applicationSid = tempKey,行为与旧 sessions.set(tempKey) 字面等价
    // - resume / fallback 路径(有 opts.resume): applicationSid = opts.resume,Map key 与
    //   createUserMessageStream / sendMessage / canUseTool 等 callsite 用的 internal.applicationSid 对齐;
    //   否则 sessions.has(applicationSid) miss → 流断,符合 plan §S4b 不变量「sessions Map key = applicationSid」
    // first realId 到达后 stream-processor.ts S3 isNewSpawn 分支 spawn 主路径 delete tempKey + set realId,
    // resume 路径不再 mutate sessions Map (Map key 已是 applicationSid 不变)。
    deps.sessions.set(internal.applicationSid, internal);

    // 等待第一条带 session_id 的 SDKMessage（system init 几乎一定会先到）
    // REVIEW_5 H4：把 opts.resume 传下去，30s fallback 时用 OLD_ID 作 sessionId
    // 替代 tempKey emit 占位事件，让 ingest 走 existing 分支不再创建第二条 active record
    // **plan reverse-rename-sid-stability-20260520 §A.4-pre S1 R6 + R7 修订**: 透传
    // effectiveResumeCliSid + resumeMode 给 consume() 让 isNewSpawn 三分支 + S6 fork detect
    // 用 effective 值不 short-circuit。
    realId = await deps.streamProcessor.waitForRealSessionId(
      internal,
      tempKey,
      opts.resume,  // resumeId 入参 = applicationSid 维度 (fallback emit 占位用)
      effectiveResumeCliSid,
      opts.resumeMode,
    );

    // A1-HIGH-1 修法（plan deep-review-batch-a1-b-fixes-20260519 / REVIEW_46）:
    // 旧 impl waitForRealSessionId 在 SDK 流结束但从未发 first session_id frame 时
    // resolve(realId ?? tempKey) = tempKey（stream-processor.ts:180）。createSession 继续
    // 走 finalizeSessionStart 创建一条 sessionId=tempKey 的假 DB record（无 SDK live state）
    // + opts.resume 的 sdkOwned claim 永不释放（OLD_ID 后续 hook 事件被静默吞 = leak）。
    // 修法 (A) 彻底失败语义: realId === tempKey 表示 consume 自吞错且 fallback 也没拿到
    // resumeId（非 resume 路径）→ throw 让 createSession 进 catch L298 走完整 cleanup
    // （sessions.delete + releasePending + releaseSdkClaim(opts.resume) + throw IPC）。
    // renderer 收到 error 直接显示，不创建假会话（A1-HIGH-1 双方共识真问题 + reviewer-claude
    // 反驳轮精确时序追踪铁证 + lead 现场验证 finalizeSessionStart emit session-start 链路写
    // sessionId=tempKey 的 DB record + sessions.delete(tempKey) 后 finalize 仍执行）。
    if (realId === tempKey) {
      throw new Error(
        'createSession: SDK stream ended without emitting first session_id frame ' +
          '(consume swallowed SDK error / no resume id available). ' +
          'Refusing to create a session-less DB record.',
      );
    }

    // 注册到 SessionManager 的 sdk-owned 集合，后续 hook 回环将被去重
    sessionManager.claimAsSdk(realId);
  } catch (err) {
    // 任何中间步骤抛错：回滚 sessions / 释放 pending，再 throw 给上层 IPC 显错
    // **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 2.5 修法 (H2 + A1-HIGH-1 race 双保险 (A) abort consume)**:
    // catch 块入口立刻 set expectedClose=true + fire-and-forget interrupt() 防 detached SDK
    // 子进程继续跑 LLM 调用 + 防 SDK in-flight first-id frame 撞 Phase 2.2 (B) guard 入口
    // (sdk-message-translate.ts:159 expectedClose skip 路径已 land,详 D2 注释)。**idempotency
    // guard** (R3 plan-review codex LOW-1 + claude INFO 收窄文案): interruptFired flag 仅作用
    // 本路径 + stream-processor.ts setTimeout fallback fire 路径双路径,不覆盖 public
    // interrupt(sessionId) + closeSession(sessionId) 入口 (设计内 — caller 显式调用应当直通
    // SDK,与 spike1 实证 interrupt() 幂等 SDK 行为一致)。
    if (!internal.interruptFired) {
      internal.expectedClose = true;
      internal.interruptFired = true;
      // R3 fix-7 (I1 reviewer-claude INFO + codex A MED-1): 加 .catch 吞错防 unhandled
      // rejection（SDK interrupt 在 catch 路径 reject 可能性）。fire-and-forget 语义保持。
      void internal.query?.interrupt?.().catch((err: unknown) => {
        logger.warn('[sdk-bridge] interrupt during createSession throw failed:', err);
      });
    }
    // REVIEW_60 R2 HIGH-1 修法 (reviewer-claude R2 单方 finding + lead 现场验证 + 与 codex catch 对照 parity gap):
    // 旧 bug: catch 块只 `sessions.delete(tempKey)` 但 plan reverse-rename-sid-stability-20260520
    // §A.4-pre S2 已把 sessions.set 切到 applicationSid (L380),resume 路径下 applicationSid =
    // opts.resume ≠ tempKey,catch sessions.delete(tempKey) 是 no-op → opts.resume entry 永远
    // 留在 Map 里。后续 sendMessage(opts.resume) → sessions.get 命中 stale internal → 跳过
    // recoverer 自愈主路径 → push pendingUserMessages 进 stale internal → SDK 已 abort → 静默卡死。
    // 触发条件: opts.resume 路径 + try 内 sessions.set 之后 throw (waitForRealSessionId 30s
    // timeout / A1-HIGH-1 realId === tempKey throw / 其他 try 内 throw)。
    // 修法: 两个 key 同时清 — applicationSid 覆盖 spawn 主 / resume / 反向 rename 后场景;
    // tempKey 兼容 stream-processor.ts first realId 切 key 在 catch 之前完成的边角 (spawn
    // 主路径 isNewSpawn 三分支保护已 delete tempKey + set realId,本句 no-op safety net)。
    // 与 codex/sdk-bridge/index.ts:799 同款 parity 收口 (codex 端正确用 initialSid)。
    if (deps.sessions.get(internal.applicationSid) === internal) {
      deps.sessions.delete(internal.applicationSid);
    }
    if (deps.sessions.get(tempKey) === internal) {
      deps.sessions.delete(tempKey);
    }
    releasePending();
    // REVIEW_5 H4：构造期就 claim 了 opts.resume，失败路径必须释放，
    // 否则下次同 sessionId 的真实 hook / 终端 CLI 会话会被静默吞掉
    if (opts.resume) sessionManager.releaseSdkClaim(opts.resume);

    // REVIEW_75 HIGH (reviewer-codex + lead 代码链实测三重确认):清掉失败路径落下的孤儿
    // tempKey DB row。
    // 根因:consume() 在 try 内会经 emit() 链路走 sessionManager.ingest — 无论是 30s timeout
    // 的「⚠ SDK 30 秒」error message(stream-processor.ts:219)还是 consume finally 必发的
    // session-end(stream-processor.ts:446),event.source==='sdk' 在 dedupOrClaim 5 个 skip 分支
    // (全部要求 source==='hook')里一个都不命中 → ensureRecord 必建一条 id=tempKey/source='sdk'
    // 的 DB row(随后 session-end 把它推成 dormant)。catch 此前只 delete in-memory Map + release
    // claim,**从不删这条 DB row** → SessionList 永久残留一条无 jsonl / 无 SDK live state 的幽灵
    // dormant 会话(只能等 historyRetentionDays 时间清理,默认可能永不清)。A1-HIGH-1 的
    // realId===tempKey throw 只挡住了 finalizeSessionStart 这一条创建源,挡不住更早的 consume
    // emit 链路。
    //
    // **只删 tempKey 不删 applicationSid**(安全边界,防误删 resume 合法历史):
    // - spawn 主路径:applicationSid === tempKey,孤儿 row 的 id 就是 tempKey,删之安全
    // - resume 路径:applicationSid === opts.resume(预先存在的合法 row);且 resume 路径 fallback
    //   用 fallbackId=resumeId≠tempKey → realId≠tempKey 永不进 A1-HIGH-1 throw;其他 try 内 throw
    //   也绝不能删 opts.resume 行(那是用户历史会话)。故这里**只**删 tempKey,opts.resume 行不动。
    // - tempKey 是 randomUUID,删一条不存在的 tempKey row 是无害 no-op(DELETE WHERE id=? 命中 0 行)。
    if (!ctx.initialSessionEmitted) {
      try {
        sessionRepo.delete(tempKey);
      } catch (delErr) {
        logger.warn(`[sdk-bridge] 清理孤儿 tempKey row 失败: ${tempKey}`, delErr);
      }
    }
    throw err;
  }

  return { realId };
}
