/**
 * codex sdk-bridge 冷切 sandbox 控制器（R37 P2-E Step 3.4c）。
 *
 * 抽自 CodexSdkBridge.restartWithCodexSandbox（CHANGELOG_<X> A2b）。
 * 与 claude `restart-controller.ts` (RestartController) 同模式：
 * - 通过 `RestartCtx` 注入 facade 共享 ref（recovering Map + emit + thunk closeSession + thunk createSession）
 * - 不持 sessions Map：close + createSession 已隐含管理 internal state
 * - sub-class 持 ctx 不直接持 facade，避免循环引用
 *
 * 与 claude RestartController 差异：
 * - codex 没有 `restartWithPermissionMode`（codex 不支持 permission mode 概念）
 * - 仅 `restartWithCodexSandbox` 一个方法（与 claude `restartWithClaudeCodeSandbox` 字面镜像）
 * - symmetry-plan P2 HIGH-A：加 `recovering` Map 单飞保护（与 claude 同款 REVIEW_36 R2 MED-B）
 *
 * 行为变化（symmetry-plan P2 HIGH-A + MED-A）：
 * - 加 recovering Map 单飞排队执行（修前并发 restartWithCodexSandbox 可双 SDK 子进程同 sid）
 * - DB write/rollback 后 emit `session-upserted` 让 SessionDetail 下拉值立即跟到新 mode
 *   （与 claude 同款，5-10s busy 期间用户已经看到「切完了」）
 */
import type { AgentEvent } from '@shared/types';
import { sessionRepo } from '@main/store/session-repo';
import { eventBus } from '@main/event-bus';
import { sessionManager } from '@main/session/manager';
import { AGENT_ID } from './constants';
import { maybeCodexJsonlFallback } from './codex-jsonl-fallback';
import { toCodexModelOverride } from '../sdk-model';
import { RecoveryCancelledError, isRecoveryCancelledError } from '@main/adapters/shared/recovery-cancelled';
import type { CodexSessionHandle } from './types';
import type {
  JsonlExistsThunk,
  SummariseFnThunk,
  ListEventsFnThunk,
  ListRecentMessagesFnThunk,
} from './recoverer/_deps';
import log from '@main/utils/logger';

const logger = log.scope('codex-restart');

export interface RestartCreateOpts {
  cwd: string;
  prompt?: string;
  resume?: string;
  /**
   * **plan reverse-rename-sid-stability-20260520 §C.2 R3 MED-R3-2 修订**:
   * 反向 rename 后 createSession opts.resume 是 applicationSid;codex SDK resumeThread 的 thread_id
   * 字段需要 cli sid (= rec.cliSessionId)。caller 显式传 resumeCliSid 兜底。
   */
  resumeCliSid?: string;
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
  /**
   * **REVIEW_101 R1 双方共识合并修法（codex restart 对称能力缺失 — jsonl-fallback + model）**:
   * 与 bridge CreateSessionOpts.resumeMode 对齐(claude create-session/_deps.ts — REVIEW_105 MED-1 SSOT
   * 锚点; 修前误对齐 facade ClaudeCreateOpts, 现已从 facade type 删除)让 ctx.createSession 透传
   * fallback 路径不丢精度。helper `maybeCodexJsonlFallback` fellBack=true 路径调 ctx.createSession 时显式传
   * 'fresh-cli-reuse-app' 触发 create-session-impl.ts:111 走 startThread（jsonl-missing 起 fresh thread）。
   * - 'resume-cli'(default): normal resume 行为（与本路径原 line 145 direct createSession 字面等价）
   * - 'fresh-cli-reuse-app': jsonl-missing fallback 专用 — 仅 helper 内部使用，restart caller 不直接传
   */
  resumeMode?: 'resume-cli' | 'fresh-cli-reuse-app';
  /** See CreateSessionOpts.resumeOnly. Used only for jsonl-present sandbox restart. */
  resumeOnly?: boolean;
  /**
   * **REVIEW_101 R1 reviewer-codex MED（restart 丢 model）修法**:
   * recover 路径已显式传 `model: rec.model ?? undefined`（recover-and-send-impl.ts:406 /
   * codex-jsonl-fallback.ts:216），但 restart 冷切原只传 codexSandbox → 一个带自定义 model 的 codex
   * session 切 sandbox 后 DB/UI 仍显示原 model，但新 SDK thread 实际按全局默认 model 跑
   * （create-session-impl.ts:131 仅 opts.model 非 undefined 才放进 ThreadOptions）。restart 透传
   * rec.model ?? undefined 与 recover 对称。
   */
  model?: string;
  /**
   * **REVIEW_101 R1 合并修法（parity 对称透传）**: 与 recover 路径 createSession 一致透传
   * extraAllowWrite（codex runtime 不消费仅持久化保 cross-adapter parity，与 session-finalize.ts
   * persistSessionFields 同款语义）。helper maybeCodexJsonlFallback 也需此字段对齐 recover。
   */
  extraAllowWrite?: readonly string[];
  /**
   * **plan codex-recover-network-dirs-parity-20260602（restart 对称补齐，用户确认）**:
   * recover 路径已透传 network/dirs；restart 冷切 sandbox 也对称透传。**与 extraAllowWrite 不同：
   * codex SDK runtime 真消费** —— 用户手动切 reviewer-codex 的 sandbox 档时，不透传则切档后
   * 新 thread 失去网络访问 + 跨目录能力。restart 透传 rec.networkAccessEnabled / additionalDirectories
   * ?? undefined 与 recover 对称（同 model/extraAllowWrite 透传模式）。
   */
  networkAccessEnabled?: boolean;
  /** plan codex-recover-network-dirs-parity-20260602（restart 对称）：见 networkAccessEnabled。 */
  additionalDirectories?: readonly string[];
  /**
   * **REVIEW_101 R1 双方共识 MED（restart 缺 cancel-guard）修法**:
   * restart 冷切 createSession await 窗口内若用户主动 close / scheduler 衰减 dormant→closed /
   * MCP shutdown_session（三入口均 bumpCloseEpoch + setLifecycle='closed'）→ restart 继续 emit
   * session-start(source:'sdk') → ensure closed→active 复活幽灵（与 recover 路径 REVIEW_99 R3 修的
   * 同款 race，两端 restart 路径 pre-existing 共缺）。restart 传 cancelCheck=cancelGuard 让
   * create-session-resume.ts:55 在 sessions.set 前查 epoch：变了 throw RecoveryCancelledError abort。
   */
  cancelCheck?: () => boolean;
}

export interface RestartCtx {
  /**
   * symmetry-plan P2 HIGH-A：与 claude `RestartCtx.recovering` 同模式 — 与 facade 共享的
   * 单飞 Map（facade 持权威 ref，restart-controller mutate 同一份）。同 sessionId 的并发
   * `restartWithCodexSandbox` 排队执行。未来 HIGH-B codex recoverer 也共享本 Map。
   */
  recovering: Map<string, Promise<unknown>>;
  emit: (event: AgentEvent) => void;
  /** thunk 反调 facade.closeSession，避免直接持有 facade ref（与 claude RestartCtx 同模式）。 */
  closeSession: (sessionId: string) => Promise<void>;
  /** thunk 反调 facade.createSession，restart 路径用 resume + 新 sandbox 重建。 */
  createSession: (opts: RestartCreateOpts) => Promise<CodexSessionHandle>;
  /**
   * **REVIEW_101 R1 双方共识合并修法（codex restart 接入 maybeCodexJsonlFallback）**:
   * helper `maybeCodexJsonlFallback` 需要的 4 thunk（与 RecovererCtx 共享同一份 instance —
   * facade index.ts 注入，对齐 claude RestartCtx）。codex restart 修前完全无 jsonl 处理 → jsonl
   * 缺失（用户清 ~/.codex/sessions / 跨设备同步未带）时冷切 sandbox 走 resumeThread earlyErr →
   * 回滚旧档 = 切档失败（claude 同场景一次成功）。补这 4 thunk 让 codex restart mirror claude /
   * recover 的 jsonl 预检 + fallback。
   */
  jsonlExistsThunk: JsonlExistsThunk;
  summariseFn: SummariseFnThunk;
  listEventsFn: ListEventsFnThunk;
  listMessagesFn: ListRecentMessagesFnThunk;
}

export class RestartController {
  constructor(private ctx: RestartCtx) {}

  /**
   * 冷切 codex sandbox 档位（CHANGELOG_<X> A2b）：销毁旧 thread + 用新 sandbox resume 重建。
   *
   * 与 claude restartWithClaudeCodeSandbox 同模式：
   * - 单飞：等同 sessionId 的 in-flight recovery / restart 完成（symmetry-plan P2 HIGH-A）
   * - close OLD → 写 DB → emit session-upserted → createSession({resume, codexSandbox, resumeOnly})
   * - 失败回滚 sessionRepo.codexSandbox + emit session-upserted 让下拉回弹 + emit error message
   *
   * codex SDK sandboxMode 是 startThread/resumeThread spawn-time 锁定，无法运行时热切；
   * 必须冷切（销毁旧 thread + 重建）。spike-A2 实测确认 resumeThread 透传新 sandbox 真生效。
   *
   * @returns 重启后的 sessionId（codex resume 不会隐式 fork，理论上等于入参 sid，
   *   但接口签名与 claude 对齐保留 string 返回）
   */
  async restartWithCodexSandbox(
    sessionId: string,
    sandbox: 'workspace-write' | 'read-only' | 'danger-full-access',
    handoffPrompt: string,
  ): Promise<string> {
    // symmetry-plan P2 HIGH-A：单飞 — 等同 sessionId 的 in-flight restart 完成
    // （与 claude restart-controller REVIEW_36 R2 MED-B 修法同款）。先等再起,避免并发
    // restart 同时进 close → DB write → createSession 阶段交错。
    //
    // **REVIEW_56 MED-1 修法**(与 claude restart-controller.ts:153-163 同款 while 循环):
    // 修前 单 if 仅 wait 一次 → 3 并发 waiter race(A inflight 中 B/C 都 await A;A done 后
    // B/C **同时**进入下面 close → DB → createSession 阶段,既越过单飞又重复执行)。修后
    // while 循环 re-check `recovering Map`,若期间 B 已注册新 inflight,C 继续等。
    // codex 这边不需 listener transfer Map entry(claude 那边因 SDK 软 fork rename + Map
    // key 切换才需要 transfer;codex spike-A2 实测 codex resume 不 fork,sessionId 全程稳定)。
    let inflight = this.ctx.recovering.get(sessionId);
    while (inflight) {
      try {
        await inflight;
      } catch {
        // 上一个 restart 失败不影响本次重启尝试
      }
      inflight = this.ctx.recovering.get(sessionId);
    }

    const rec = sessionRepo.get(sessionId);
    if (!rec) throw new Error(`session ${sessionId} not found in repo`);
    const oldSandbox: 'workspace-write' | 'read-only' | 'danger-full-access' | null =
      rec.codexSandbox ?? null;
    const sdkModel = toCodexModelOverride(rec.model);

    // symmetry-plan P2 HIGH-A：单飞标记必须在 closeSession + DB write + createSession **之前**
    // set，覆盖整个冷重启的副作用窗口（与 claude REVIEW_36 R2 MED-B 修法同款）。原实现
    // 直接顺序跑 close → DB → createSession，两个并发 restart 都能越过 inflight 检查同时进入。
    const p = (async (): Promise<string> => {
      // **REVIEW_101 R1 双方共识 MED（restart 缺 cancel-guard）修法 + R2 INFO-A（reviewer-claude 强化
      // 建议，lead 现场验证采纳）— cancellation-epoch baseline 捕获时机移到 `await ctx.closeSession`
      // 之前**:
      // restart 冷切期间用户主动 close / scheduler 衰减 dormant→closed / MCP shutdown_session（三入口均
      // bumpCloseEpoch + setLifecycle='closed'，lifecycle.ts:107/150 + lifecycle-scheduler.ts:103）→ 若不
      // gate，createSession 继续 emit session-start(source:'sdk') → ensure closed→active 复活幽灵（与
      // recover 路径 REVIEW_99 R3 修的同款 race；两端 restart 路径 pre-existing 共缺，claude restart 同样
      // 无此 guard → claude 侧留 follow-up parity）。
      //
      // **为何在 `await ctx.closeSession` 之前捕获（R2 INFO-A 订正 R1 的「之后」位置）**：lead 现场 trace
      // 确认 codex adapter 层 `ctx.closeSession`（index.ts:425-472）只 abort turn + sessions.delete +
      // releaseSdkClaim，**不** setLifecycle / 不 bumpCloseEpoch（只有 sessionManager.close/markClosed/
      // delete 才 bump）→ baseline 在 close 前后捕获**值等价**。但 `await ctx.closeSession` 仍让出
      // microtask；若用户 `sessionManager.close`（不查 recovering Map，单飞挡不住）正好在该 microtask 窗口
      // 内跑完 bump+setClosed，baseline 放「close 之后」会把这次 close 算进基线 → 漏判。移到 close **之前**
      // 捕获 → 连 closeSession 让出的 microtask 窗口内的 close 都被 cancelGuard 后续检查捕获（baseline <
      // 新 epoch → abort），与 recover 路径「baseline 捕获前全同步无 await」语义更一致。残留固有 TOCTOU
      // （baseline 捕获瞬间到首检查点之间的 close）是 cancellation-epoch 全路径共有边界，recover 同样不覆盖。
      const closeEpochBaseline = sessionManager.getCloseEpoch(sessionId);
      const cancelGuard = (): boolean => {
        if (!sessionRepo.get(sessionId)) return true; // record await 期间被删 → abort
        return sessionManager.getCloseEpoch(sessionId) !== closeEpochBaseline;
      };

      // close OLD：内部 intentionallyClosed=true → abort current turn → runTurnLoop 静默退出
      await this.ctx.closeSession(sessionId);

      // **REVIEW_80 MED 修法（reviewer-claude + reviewer-codex 双方独立共识）**:
      // forward setCodexSandbox 必须纳入 try。修前它在 try 之外（closeSession 之后裸调），
      // better-sqlite3 同步 `.run()` throw（SQLITE_BUSY / disk full / corrupt）时异常直接冒出
      // IIFE → 跳过 catch 的全部补救（rollback + emit error）→ 用户卡在占位「正在切换…」文案
      // 无 finished / 无 error bubble（自愈靠下条消息走 recoverer，但本次切档静默失败 + 占位卡死），
      // 违反 ipc/adapters.ts:395 契约「adapter 内部已 emit error / 回滚 DB」。纳入 try 后
      // setCodexSandbox throw 走 catch emit error 收口占位文案。
      // 与 claude restart-controller.ts:378 同款 latent pattern（parity-shared，claude 侧留 follow-up）。
      try {
        // 先写 DB：让 createSession resume 路径能从 sessionRepo 读到新 sandbox。
        // symmetry-plan P2 MED-A：写库后 emit session-upserted 让 SessionDetail 下拉值立即跟到
        // 新 mode（与 claude 同款，5-10s busy 期间用户已经看到「切完了」）。
        sessionRepo.setCodexSandbox(sessionId, sandbox);
        const updatedRec = sessionRepo.get(sessionId);
        if (updatedRec) eventBus.emit('session-upserted', updatedRec);

        // **REVIEW_101 R1 双方共识合并修法（codex restart 接入 maybeCodexJsonlFallback）**:
        // 修前 codex restart 完全无 jsonl 处理，close OLD → 写 DB → 直接 createSession({resume}) →
        // create-session-impl.ts:111 resumeMode 默认走 resumeThread → jsonl 缺失（用户清
        // ~/.codex/sessions / 跨设备同步未带）时 codex CLI resume 抛 earlyErr → 回滚旧档 = 切档失败
        // （claude restart 同场景一次成功，line 217/402 已有 maybeJsonlFallback）。接入对称：
        // - jsonl 在 → fellBack=false → fall through 到下方 direct createSession resume（控制流不变；
        //   见下方 fall-through 处 R2 INFO-B 注释：model 透传是本次 fix 的故意变更非字面等价）
        // - jsonl 缺 → fellBack=true → helper 已包办 fresh-cli-reuse-app createSession + 历史注入 +
        //   emit fallback info，直接 return（不再重复 createSession）
        // - aborted（cancelGuard 在 helper await injectResumeHistory 后命中）→ 静默结束不回滚
        // restart 路径 handoffPrompt 不在入口 emit 落库 → 无「当前消息」需排除 → maxEventIdFn 返 null
        // （injectResumeHistory 退化为「查最近 N」不加边界，与 claude restart maybeJsonlFallback 同款）。
        const fbResult = await maybeCodexJsonlFallback(
          {
            jsonlExistsThunk: this.ctx.jsonlExistsThunk,
            createSession: this.ctx.createSession,
            emit: this.ctx.emit,
            summariseFn: this.ctx.summariseFn,
            listEventsFn: this.ctx.listEventsFn,
            listMessagesFn: this.ctx.listMessagesFn,
          },
          {
            sessionId,
            cliSessionId: rec.cliSessionId ?? null,
            startedAt: rec.startedAt,
            cwd: rec.cwd,
            // restart 路径 cwd 不 fallback（rec.cwd 直用）→ prependCwd === cwd
            prependCwd: rec.cwd,
            prompt: handoffPrompt,
            // restart handoffPrompt 不入口 emit → 无当前消息需排除 → 返 null（退化查最近 N 不加边界）
            maxEventIdFn: () => null,
            codexSandbox: sandbox,
            // **REVIEW_101 R1 MED（restart 丢 model）**: 透传 rec.model 与 recover 对称（否则 fallback
            // 起 fresh thread 仍按全局默认 model 跑）。
            model: sdkModel,
            extraAllowWrite: rec.extraAllowWrite ?? undefined,
            // **plan codex-recover-network-dirs-parity-20260602（restart 对称）**: jsonl-missing
            // fallback 起 fresh thread 时透传 network/dirs（codex SDK runtime 真消费）与 recover 对称。
            networkAccessEnabled: rec.networkAccessEnabled ?? undefined,
            additionalDirectories: rec.additionalDirectories ?? undefined,
            // **REVIEW_101 R1 cancel-guard**: 传 isCancelledFn 让 helper await injectResumeHistory
            // 后、createSession 前查 epoch（用户 await 窗口内 close → abort 不起 fresh thread）。
            isCancelledFn: cancelGuard,
          },
        );
        // **REVIEW_101 R1 cancel-guard**: abort 优先判定（用户 await 窗口内 close，epoch 变）。
        // restart 路径 abort 时不回滚 sandbox、不 emit「切档失败」红字（lifecycle 已是用户想要的
        // closed）→ throw RecoveryCancelledError 让 outer catch special-case 静默结束。
        if (fbResult.aborted) {
          throw new RecoveryCancelledError(sessionId);
        }
        if (fbResult.fellBack) {
          // helper 已包办 createSession + emit，applicationSid 全程不变（== sessionId）
          //
          // **REVIEW_101 R1 已知差异（lead 标注，待 R2 评判）**: codex maybeCodexJsonlFallback 硬编码
          // `skipFirstUserEmit: true`（codex-jsonl-fallback.ts:221，假设 recover 路径 entry 已 emit
          // user message），且 codex helper **不**像 claude helper 那样自 emit role='user'。restart 路径
          // 无 entry emit → fallback 分支下 handoffPrompt **不显示为 user bubble**（仅 emit fallback
          // info message）。影响有限：① fallback 仅 jsonl 缺失（罕见）触发 ② handoffPrompt 是系统冷切
          // 提示语非用户珍贵输入 ③ 修前此场景整个切档失败（reviewer-claude MED），修法后切档成功只是
          // 少一条系统 prompt bubble = 净改善。与 claude restart fallback（claude helper 自 emit user）
          // 存在 parity 差异，根因 = codex helper 当前只为 recover 设计（无 emitContext 概念）。彻底对齐
          // 需 codex helper 加 emitContext + 自 emit user 分支（claude jsonl-fallback.ts:384 模式），
          // 改动较大 → 留 follow-up（与 claude restart cancel-guard follow-up 同批 parity 收口）。
          return fbResult.finalSessionId;
        }
        // fellBack=false → fall through 到正常 resume 路径。
        // **REVIEW_101 R2 INFO-B（reviewer-claude 措辞订正）**：jsonl 在时**控制流**与修前 direct
        // createSession 等价，但 model 透传是本次 fix 的**故意行为变更**——修前 fall-through 不传 model，
        // create-session-impl 对 model 无 sessionRepo fallback（不同于 sandbox 有 persistedSandbox），
        // 故修前 jsonl 在 + rec.model 非空时 ThreadOptions 不带 model → codex 按全局默认 model 跑（=
        // reviewer-codex R1「restart 丢 model」MED 根因）。仅 rec.model 为 null 时才与修前字面等价。
        //
        // **CHANGELOG_223 撤回 221 注入**：jsonl 在时 codex resumeThread 已从 thread jsonl 续上完整
        // 上下文，**不**再注入 DB 摘要/原始对话（注入只会让模型把整段历史当成新输入）。仅 jsonl 缺失的
        // maybeCodexJsonlFallback 路径才靠 injectResumeHistory 续历史。

        const handle = await this.ctx.createSession({
          cwd: rec.cwd,
          resume: sessionId,
          // **plan reverse-rename-sid-stability-20260520 §C.2 R3 MED-R3-2 修订**:
          // 显式传 cli sid 让 codex SDK resumeThread 拿正确 thread_id (反向 rename 后两者不同时)。
          resumeCliSid: rec.cliSessionId ?? sessionId,
          codexSandbox: sandbox,
          resumeOnly: true,
          // **REVIEW_101 R1 MED（restart 丢 model）**: 透传 rec.model 与 recover-and-send-impl.ts:406 对称。
          model: sdkModel,
          extraAllowWrite: rec.extraAllowWrite ?? undefined,
          // **plan codex-recover-network-dirs-parity-20260602（restart 对称）**: 正常 resume 重建
          // thread 透传 network/dirs（codex SDK runtime 真消费）与 recover 对称。
          networkAccessEnabled: rec.networkAccessEnabled ?? undefined,
          additionalDirectories: rec.additionalDirectories ?? undefined,
          // **REVIEW_101 R1 cancel-guard**: 传 cancelCheck 让 create-session-resume.ts:55 在
          // sessions.set 前查 epoch（pre-registration await 窗口内 close → throw sentinel abort）。
          cancelCheck: cancelGuard,
        });
        // **plan reverse-rename-sid-stability-20260520 §C.2 反向 rename 修订**:
        // codex resume 路径下 applicationSid 全程不变 = sessionId;
        // CLI 真实 fork (case 3) 由 thread-loop 内部走 sessionManager.updateCliSessionId 黑名单链
        // (与 §A.4-pre S6 同款),不再调 sessionManager.renameSdkSession。
        // codex-tests-plan P3 LOW (REVIEW_40 R2 reviewer-codex):原 post-rename 防御 block 已删
        // (commit 6e0eb37 / REVIEW_40 注释);thread-loop case 3 是 SSOT。
        return handle.sessionId;
      } catch (err) {
        // **REVIEW_101 R1 cancel-guard 统一 abort 收口（对称 recover-and-send-impl.ts:439）**:
        // sentinel special-case 必须在 generic catch **之前**。用户在 restart createSession await
        // 窗口内 close（epoch 变）→ maybeCodexJsonlFallback aborted / create-session-resume
        // pre-registration guard 都 throw RecoveryCancelledError。此时 lifecycle 已是用户想要的
        // closed，**不**回滚 sandbox（回滚会 emit session-upserted 让已 closed 会话下拉值闪动）、
        // **不** emit「切到 sandbox 失败」红字（用户主动 close 不该看到切档失败错误）。静默结束。
        if (isRecoveryCancelledError(err)) {
          logger.warn(
            `[codex-bridge] restartWithCodexSandbox aborted (session closed during restart): ${sessionId}`,
          );
          return sessionId; // 静默结束（lifecycle 已是用户想要的 closed，无需回滚 / 不抛错给 renderer）
        }
        // 回滚：DB 改回 oldSandbox + emit session-upserted 让下拉回弹 + emit error message。
        // **REVIEW_80 MED 修法 (a)（reviewer-claude 补充细节）**: rollback write 自身必须包
        // try/catch — 修前 line 152 裸调 setCodexSandbox(oldSandbox)，持续性 DB 故障下回滚再
        // throw 会掩盖原始 err（createSession 错因丢失）+ 跳过下方 emit error message。包 try/catch
        // 后回滚失败仅 warn，原始 err 仍透传 + error message 仍 emit。
        // 注:forward setCodexSandbox throw 时 DB 未写成新值,回滚写 oldSandbox 是 idempotent no-op 安全。
        try {
          sessionRepo.setCodexSandbox(sessionId, oldSandbox);
          const rolled = sessionRepo.get(sessionId);
          if (rolled) eventBus.emit('session-upserted', rolled);
        } catch (rollbackErr) {
          logger.warn(
            `[codex-bridge] restartWithCodexSandbox rollback setCodexSandbox(${sessionId}, ${oldSandbox}) 失败（持续性 DB 故障），原始 err 仍透传:`,
            rollbackErr,
          );
        }
        this.ctx.emit({
          sessionId,
          agentId: AGENT_ID,
          kind: 'message',
          payload: {
            text:
              `⚠ 切到 sandbox ${sandbox} 失败：${(err as Error)?.message ?? String(err)}。` +
              `档位已回退到 ${oldSandbox ?? '(默认)'}，请重新发送一条消息让 Codex 续上。`,
            error: true,
          },
          ts: Date.now(),
          source: 'sdk',
        });
        throw err;
      }
    })();
    this.ctx.recovering.set(sessionId, p);
    try {
      return await p;
    } finally {
      this.ctx.recovering.delete(sessionId);
    }
  }
}
