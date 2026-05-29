/**
 * SessionRecoverer — 断连自愈 + jsonl 兜底（CHANGELOG_52 Step 3d）。
 *
 * **Step 4.4 facade 拆分**：原 670 LOC 拆完后本文件作 thin facade：
 * - SessionRecoverer class shell + ctor (7 thunk 注入)
 * - recoverAndSend thin delegate → `./recoverer/recover-and-send-impl.ts:recoverAndSendImpl`
 * - emitFallbackMessage class 内 private method 收口（user Q3 confirm 推荐方案）
 * - findFallbackCwd protected method 留 class 内（test 通过 extend facade override）
 * - 5 thunk type / 1 ctx interface re-export from `./recoverer/_deps.ts`
 * - 2 default helper re-export from `./recoverer/jsonl-discovery.ts`
 *
 * **State 所有权**：
 * - `recovering` Map：**SHARED**，与 lifecycle.restartWithPermissionMode 双方读写同一份
 *   单飞表（CHANGELOG_26）。原 plan 错把它当 recoverer 独占，F2 finding 修法：
 *   提到 facade 持有 → ctx 注入。
 * - `placeholderEmittedAt` Map：**recoverer 独占**，5s dedup 同 sessionId 短时间反复 recover
 *   重 emit「⚠ SDK 通道已断开...」噪声（REVIEW_17 R3 / M3-R3）。
 *
 * **循环依赖**（F1 修法）：
 * - recoverAndSend 调 facade.createSession（resume / 不带 resume 兜底）→ 走 createThunk
 * - recoverAndSend 调 facade.sendMessage（inflight 等完后递归把第二条 text 正常 push）→ 走 sendThunk
 * - resumeJsonlExists 走 jsonlExistsThunk（test 通过子类化 facade override resumeJsonlExists）
 *
 * **护栏**（不变）：
 * - CHANGELOG_26 — recovering 单飞 + 30s placeholder UX
 * - CHANGELOG_28 — jsonl 预检不在则走不带 resume 的新建 createSession + 事后 renameSdkSession
 * - CHANGELOG_31 — 用户显式发消息触发 recoverAndSend 自动 unarchive
 * - REVIEW_7 H1 — 用 createSession 返回值拿 newRealId（不再 entries() 反查 cwd）
 * - REVIEW_17 R3 — 5s placeholder dedup
 */
import type { AgentEvent, UploadedAttachmentRef } from '@shared/types';
import { findFallbackCwd as findFallbackCwdShared } from '@main/adapters/shared/find-fallback-cwd';
import { AGENT_ID } from './constants';
import { recoverAndSendImpl } from './recoverer/recover-and-send-impl';
import type {
  CreateSessionThunk,
  CwdExistsThunk,
  JsonlExistsThunk,
  RecovererCtx,
  SendMessageThunk,
  SummariseFnThunk,
} from './recoverer/_deps';

// re-export 5 thunk type + 1 ctx interface — caller 仍按
// `import { SessionRecoverer, RecovererCtx, ... } from '@main/adapters/claude-code/sdk-bridge/recoverer'`
// 方式 import (Step 4.4 facade re-export 保 import path byte-identical)。
export type {
  CreateSessionThunk,
  CwdExistsThunk,
  JsonlExistsThunk,
  RecovererCtx,
  SendMessageThunk,
  SummariseFnThunk,
};

// re-export 2 default fn — facade.ctor 默认值 + sdk-bridge.ts:46 import 链兼容
export {
  defaultCwdExists,
  defaultResumeJsonlExists,
} from './recoverer/jsonl-discovery';

export class SessionRecoverer {
  /**
   * REVIEW_17 R3 / M3-R3：recoverAndSend 入口 emit 占位 message 的 dedup 窗口。
   * 同 sessionId 短时间内被多次 recover 触发（首次 inflight 失败 swallow + 再次
   * sendMessage 重新进 recoverAndSend）会 emit 多条「⚠ SDK 通道已断开...」噪声。
   * 5s 窗口（PLACEHOLDER_DEDUP_MS）够覆盖单飞失败到下次 sendMessage 的典型间隔。
   */
  private readonly placeholderEmittedAt = new Map<string, number>();

  constructor(
    private readonly ctx: RecovererCtx,
    private readonly createThunk: CreateSessionThunk,
    private readonly sendThunk: SendMessageThunk,
    /**
     * jsonl 探测 thunk —— facade 内部转发给 protected resumeJsonlExists 方法（test 通过
     * extend facade override resumeJsonlExists），保证现有测试范式（TestBridge）不破。
     */
    private readonly jsonlExistsThunk: JsonlExistsThunk,
    /**
     * CHANGELOG_99：cwd 存在性探测 thunk(test seam)。facade 内部转发给 protected
     * cwdExists 方法,默认走 fs.existsSync。
     */
    private readonly cwdExistsThunk: CwdExistsThunk,
    /**
     * CHANGELOG_107: LLM 摘要 thunk(test seam)。facade 内部转发给 protected
     * summariseForHandOff 方法,默认实现 = `summariseSessionForHandOff`。
     *
     * Step 1: 仅接通 thunk 通道,recoverer 主路径暂不调用(零业务行为变化)。
     * Step 2 起 `prependHistorySummary` helper 在 fallback 路径前调用本 thunk
     * 把摘要 prepend 到 fresh CLI 首条 prompt。
     */
    private readonly summariseFn: SummariseFnThunk,
    /**
     * **plan restart-controller-jsonl-precheck-20260521 §Step 3g 修法**:
     * events 来源 thunk(test seam)。facade 内部转发给 protected
     * listEventsForSession 方法,默认走 `eventRepo.listForSession`。
     *
     * 让 jsonl-fallback helper (Step 3f 重构后 fallback 路径调本 thunk) 与 recoverer
     * 主路径共享同款 facade extend override 模式(避免 recoverer.ts 与 helper 双处
     * hardcode eventRepo 漂移)。
     */
    private readonly listEventsFn: (sessionId: string) => AgentEvent[],
  ) {}

  /**
   * 断连自愈 + 单飞复用 — Step 4.4 拆完后 thin delegate to `recoverAndSendImpl`。
   * 详 `recover-and-send-impl.ts` jsdoc 与 callsite 约束保留。
   */
  async recoverAndSend(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
  ): Promise<string> {
    return recoverAndSendImpl(sessionId, text, attachments, {
      ctx: this.ctx,
      createThunk: this.createThunk,
      sendThunk: this.sendThunk,
      jsonlExistsThunk: this.jsonlExistsThunk,
      cwdExistsThunk: this.cwdExistsThunk,
      summariseFn: this.summariseFn,
      listEventsFn: this.listEventsFn,
      findFallbackCwdThunk: (badCwd) => this.findFallbackCwd(badCwd),
      emitFallbackMessageThunk: (sid, text, opts) => this.emitFallbackMessage(sid, text, opts),
      placeholderEmittedAt: this.placeholderEmittedAt,
    });
  }

  /**
   * REVIEW_37 P3-C Step 4.3: emit fallback message struct 收口（与 Step 1.3 抽出的 6 个
   * recoverer-messages.ts builder 1:1 配套）。
   *
   * **抽出动机**：recoverer.ts 内 6 处 `this.ctx.emit({ sessionId, agentId: AGENT_ID,
   * kind: 'message', payload: { text: builder(...) }, ts: Date.now(), source: 'sdk' })`
   * 字面镜像 100%，仅 payload.text / payload.error 不同。每处占 9 行让 emit 时机
   * 与控制流交织阅读体验差；helper 收口后 caller 一行 `emitFallbackMessage(sid, builder(...))`
   * 自描述意图。
   *
   * **覆盖范围**（与 builder #1-#6 1:1）：
   * - outer cwd missing throw（buildCwdMissingErrorText，带 `error: true`）
   * - outer cwd fallback info（buildCwdFallbackInfoText）
   * - inner jsonl missing summary used / skipped（buildJsonlMissingSummary*Text）
   * - inner cwdFellBack summary used / skipped（buildCwdFallbackSummary*Text）
   *
   * **不覆盖**（recoverer-messages.ts 注释明示「单行字面量留 inline」）：
   * - 占位 message 「⚠ SDK 通道已断开，正在自动恢复…」（占位 dedup 用 nowTs 同款 const）
   * - 兜底失败 message 「⚠ 自动恢复失败：${err}」（err.message 内联，无 builder）
   *
   * @param sessionId 当前 recover 中的 sessionId
   * @param text 调 builder 出来的最终文案
   * @param opts.error 是否 emit error message（默认 false → info 性质）
   */
  private emitFallbackMessage(
    sessionId: string,
    text: string,
    opts?: { error?: boolean },
  ): void {
    this.ctx.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: opts?.error ? { text, error: true } : { text },
      ts: Date.now(),
      source: 'sdk',
    });
  }

  /**
   * CHANGELOG_99 cwd 失效根治:启发式 fallback 算法。
   *
   * 已知 sessionRepo.cwd 不存在时(由 cwdExistsThunk 判定),尝试找一个还能用的 cwd
   * 让 SDK 子进程能正常 spawn(否则 chdir 失败,撞 "Path does not exist" 弯绕错误链)。
   *
   * **算法两阶启发式**:
   * 1. **路径含 `.claude/worktrees/` 段** → 取段之前部分(典型: K2 老 session
   *    cwd=worktree 的场景,worktree 删了之后 main repo 仍在)
   * 2. **父目录 walk** → 沿 dirname 链往上找第一个还存在的目录(覆盖手动 git worktree
   *    remove / 误删 / 跨设备同步丢目录等场景)。**安全边界**:不超过 home(避免 fallback
   *    到 `/` / `/Users/<user>` 这种用户不希望的位置;走到这种边界时返回 null)。
   *
   * 找不到 → null(handler 上层 emit error + throw,不进 placeholder 路径)。
   *
   * **fallback 后下游**:走 createThunk 不带 resume + 后置 renameSdkSession(jsonl missing
   * fallback 同款路径,CHANGELOG_28),CLI 历史失但应用层 events / file_changes / summaries
   * 子表保留(用户在 SessionDetail 看到的对话历史完全保留,因为 SessionDetail 渲染走 events
   * 表不走 CLI jsonl)。
   *
   * **不持久化 fallback cwd**:sessionRepo.cwd 不被改写。理由:fallback 是 best-effort 不动
   * 持久 state;下次发消息再次 detect → fallback,不贵(existsSync + regex)。让用户看
   * SessionDetail 还是认识"原本是哪个 worktree 的"history。
   *
   * **NOTE (caller 链路视角)** — plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.3
   * 修法(A1-MED-3 claude 降级)。虽 findFallbackCwd 本身不写 sessionRepo,但 caller 拿到
   * fallback cwd 后调 createSession({cwd: effectiveCwd, ...}) → finalize emit session-start
   * 写 newRealId 行 cwd = effectiveCwd → rename(OLD, newRealId) 后 OLD 行 DELETE,最终
   * sessionRepo.get(newRealId).cwd === effectiveCwd(fallback cwd)。SessionDetail 显示
   * fallback cwd 是设计内 by-design(旧 worktree path 永久丢失换 SDK 子进程能起来的取舍)。
   * 行为不可改 — rename 时复制 OLD.cwd 到 NEW 会撞 cwd-not-exists 死循环。
   * 故本 jsdoc 上一段「不持久化 fallback cwd」精确描述的是 **findFallbackCwd 函数本身的
   * 副作用契约**(纯函数 + best-effort + 不写库),不是 caller 链路最终持久化结果。
   *
   * test 通过 facade extend override 该方法定制启发式行为。
   *
   * **REVIEW_49 R1 follow-up MED-G**: 抽 `findFallbackCwd` 实现到 `@main/adapters/shared/find-fallback-cwd`
   * (与 codex/recoverer.ts:430 同款),本方法保留作为 facade extend override 注入点(test
   * 仍可 override 该 protected method 改启发式)。
   */
  protected findFallbackCwd(badCwd: string): string | null {
    return findFallbackCwdShared(badCwd, this.cwdExistsThunk);
  }
}
