/**
 * Phase 4 Step 4.3 create-session resume phase — thread_id 已知场景的会话登记 + 等待 thread.started。
 *
 * **触发条件**: opts.resume 非空(caller 显式传 thread id 恢复历史会话)。
 *
 * **执行序列**(索引线对应 facade index.ts L545-632 修前位置):
 * 1. sessions.set(opts.resume, internal) + claimAsSdk(opts.resume)
 * 2. emit session-start (同步派发到 sessionManager.ingest → sessionRepo.upsert)
 * 3. persistSessionFields (sandboxMode + model + extraAllowWrite UPDATE 字段,model v0.131.0+ 真生效;
 *    extraAllowWrite codex runtime 不消费仅持久化保 cross-adapter parity)
 * 4. emit user message (skipFirstUserEmit guard — recoverer 入口已 emit 时跳过避免双气泡;
 *    REVIEW_58 HIGH ✅ 收口修法,详 facade jsdoc)
 * 5. await awaitResumedThreadStart (REVIEW_60 R4 §B 抽法 #1 — 30s timeout + onFirstId + earlyErrCb
 *    4 资源 cleanup,详 helper jsdoc)
 * 6. return { sessionId: internal.applicationSid } (REVIEW_56 R2 MED-2 — facade contract 返
 *    applicationSid 而非 resumedId 防 future caller 拿 handle.sessionId 撞 sessions Map miss)
 *
 * **handOff metadata**: opts.handOff 非空时 spread 进 user message events.payload (plan
 * handoff-render-and-image-batch-20260521 §Phase 2 Step 2.2 第 9 步 — codex 3 处 emit:
 * thread-loop fallback / success / 本 resume,详 plan §不变量 5)。
 */
import { sessionManager } from '@main/session/manager';
import type { UploadedAttachmentRef } from '@shared/types';
import { AGENT_ID } from '../constants';
import { persistSessionFields } from '../session-finalize';
import { awaitResumedThreadStart } from '../resume-path-await';
import { RecoveryCancelledError } from '@main/adapters/shared/recovery-cancelled';
import log from '@main/utils/logger';
import type {
  CreateSessionDeps,
  CreateSessionOpts,
  CreateSessionResult,
  PreparedContext,
} from './_deps';

const logger = log.scope('codex-create-session-resume');

export async function runCreateSessionResumePath(
  opts: CreateSessionOpts,
  ctx: PreparedContext,
  deps: CreateSessionDeps,
): Promise<CreateSessionResult> {
  // resume 路径前置条件:opts.resume 已校验非空(orchestrator dispatch 入本 fn 前判断)
  // — 内部断言冗余但显式 narrow 让 TS 不撞 undefined 边角
  if (!opts.resume) {
    throw new Error('runCreateSessionResumePath: opts.resume must be non-empty (orchestrator dispatch invariant)');
  }
  const resumeId = opts.resume;
  const { internal, cwd, sandboxMode } = ctx;
  // **REVIEW_99 R3 cancellation-epoch MED 修法 (post-guard 窗口收口,对称 claude create-session-sdk-query)**:
  // codex orchestrator(create-session-impl.ts)在 dispatch 入本 resume 子段前已 await ensureCodex /
  // resumeThread(pre-registration window)。recover 路径若用户在这段 await 窗口内主动 close →
  // cancelCheck 返 true(close-epoch 变 / record 删)。在 sessions.set 注册 + claimAsSdk + emit
  // session-start + runTurnLoop 启动 **之前** throw RecoveryCancelledError sentinel abort:① 不起
  // turn loop ② 不 sessions.set 污染 Map ③ session-start emit 不会过 ensure closed→active 复活反转
  // 用户显式 close。sentinel 由 recoverer outer catch / waiter special-case 静默 abort。**caller 不传
  // cancelCheck(spawn / IPC / restart)→ 不 gate(undefined?.() falsy)**。
  if (opts.cancelCheck?.()) {
    throw new RecoveryCancelledError(resumeId);
  }
  if (opts.resumeOnly) {
    const readyId = await ctx.thread.ensureReady();
    if (opts.cancelCheck?.()) {
      throw new RecoveryCancelledError(resumeId);
    }
    if (!internal.threadId) {
      internal.threadId = readyId;
    } else if (internal.threadId !== readyId) {
      const oldId = internal.threadId;
      internal.threadId = readyId;
      try {
        sessionManager.updateCliSessionId(internal.applicationSid, readyId);
      } catch (renameErr) {
        logger.error(
          `[codex-create-session-resume] resumeOnly updateCliSessionId failed ` +
            `app=${internal.applicationSid}, old=${oldId}, new=${readyId}`,
          renameErr,
        );
      }
    }
  }
  // resume 路径：thread_id 已知，直接登记
  deps.sessions.set(resumeId, internal);
  sessionManager.claimAsSdk(resumeId);
  deps.emit({
    sessionId: resumeId,
    agentId: AGENT_ID,
    kind: 'session-start',
    payload: { cwd, source: 'sdk' },
    ts: Date.now(),
    source: 'sdk',
  });
  // CHANGELOG_<X> A2a：emit session-start 是同步派发到 sessionManager.ingest →
  // sessionRepo.upsert 创建 record（如果不存在）；之后调 setCodexSandbox UPDATE 字段。
  // 后续 advanceState 内 spread record 时会带上最新 codex_sandbox 不会被静默重置。
  // R37 P2-E Step 3.4b：setSandbox + setModel 收口到 persistSessionFields helper(model 真生效;
  // extraAllowWrite warn 提示仍 codex runtime 不消费,详 helper 内 try/catch + console.warn)。
  // plan cross-adapter-parity-20260515 Phase A Step A.7：extraAllowWrite 与 codexSandbox 同样
  // 持久化(parity 对称写库;不同于 model 字段 v0.131.0+ 真生效,本字段 codex runtime 不消费)。
  persistSessionFields({
    sessionId: resumeId,
    sandboxMode,
    model: opts.model,
    modelReasoningEffort: opts.modelReasoningEffort,
    extraAllowWrite: opts.extraAllowWrite,
    // plan codex-recover-network-dirs-parity-20260602：resume 路径同款透传持久化（recover 走
    // 正常 resume 时让 NEW row 字段不被静默丢弃；runtime 真生效）。
    networkAccessEnabled: opts.networkAccessEnabled,
    additionalDirectories: opts.additionalDirectories,
  });
  // REVIEW_58 HIGH ✅ 收口修法:caller 显式 skipFirstUserEmit=true 时跳过
  // (recoverer.recoverAndSend 入口已 emit,避免双气泡;详 opts.skipFirstUserEmit jsdoc)
  if (!opts.resumeOnly && !opts.skipFirstUserEmit) {
    const attachments: UploadedAttachmentRef[] | undefined =
      opts.attachments && opts.attachments.length > 0 ? opts.attachments : undefined;
    deps.emit({
      sessionId: resumeId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: {
        text: opts.prompt!,
        role: 'user',
        ...(attachments ? { attachments } : {}),
        // plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.2 第 9 步 (resume 路径
        // first-user-message emit 3 处之一,详 plan §不变量 5):spread handOff metadata 让
        // renderer 端 message-row 识别 hand-off cold-start prompt + 渲染 Hand-off badge。
        ...(opts.handOff ? { handOff: opts.handOff } : {}),
      },
      ts: Date.now(),
      source: 'sdk',
    });
  }
  if (opts.resumeOnly) {
    return { sessionId: internal.applicationSid };
  }
  // symmetry-plan P2 MED-D：await 首条 thread.started OR earlyError OR 30s timeout 才 return,
  // 让外层 createSession await 真的等待 SDK 实际状态(与 claude waitForRealSessionId 同款语义)。
  //
  // 修前问题（reviewer-claude rebuttal 反驳点 2/3 + lead 实证）：
  // - resume path 直接 `void runTurnLoop` + `return { sessionId: opts.resume }` 立即返回,
  //   restart-controller catch 在 resume path 实际死代码（runTurnLoop earlyErr 路径
  //   `else if (earlyErrCb)` 默认 undefined → emit error 自己处理,createSession 已 resolve）
  // - thread-loop:212 `&& !internal.threadId` 保护让 resume 路径跳过 thread.started.thread_id
  //   校验 → 即使 SDK 真返新 id,application layer 完全感知不到（latent silent split,future-proof
  //   防 SDK 升级 / CLI 行为变更）
  //
  // 修法：仿 startNewThreadAndAwaitId Promise 模式 + onFirstId/onEarlyError 回调:
  // - onFirstId 触发 → resolve 实际 id（thread-loop 已处理 rename 同 / 不同 id 三种情况）
  // - onEarlyError 触发 → emit finished 完成 UI 序列 + reject 让 outer (restart-controller /
  //   recoverer / ipc) catch 触发上下文相关错误处理 (如 DB rollback)
  // - 30s timeout → 退化 resolve(opts.resume) 假定 SDK 慢但能起,与新路径 resolveWithFallback
  //   不同（new 路径需 emit error + finished 完整序列；resume 已 emit session-start + user msg
  //   只缺 thread.started 后续事件,不应武断标 finished:error）
  // REVIEW_60 R4 §B 抽法 #1 修法:resume path inner Promise 三态状态机 (30s timeout +
  // onFirstId + earlyErrCb 4 资源 cleanup) 抽到 resume-path-await.ts helper。详 helper jsdoc。
  const resumedId = await awaitResumedThreadStart({
    applicationSid: resumeId,
    internal,
    deps: {
      threadLoop: deps.threadLoop,
      sessions: deps.sessions,
      codexBySession: deps.codexBySession,
      emit: deps.emit,
    },
  });
  // **REVIEW_56 R2 MED-2 修法 (reviewer-codex)**: facade resume 路径必须返
  // applicationSid 而非 resumedId(后者可能是 case 3 fork 后的新 cli sid 维度,与
  // sessions Map key + DB sessions.id 不一致 — facade contract 错;当前 recoverer
  // fallback 立即丢弃 handle 没炸,但 future caller 拿 handle.sessionId 调 sendMessage
  // 会撞 sessions Map miss 触发 recoverer 自愈循环)。
  // 与 spawn 主路径(create-session-new.ts)`return { sessionId: internal.applicationSid }` 对偶。
  // resumedId 仍可在 outer Promise 内部用作 30s timeout 早期错误处理,这里只是
  // public handle 的边界返 applicationSid。
  void resumedId; // 保留 await 形式让 timeout / earlyErr / firstIdCb 流程仍跑
  return { sessionId: internal.applicationSid };
}
