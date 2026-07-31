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
import type { UploadedAttachmentRef } from '@shared/types';
import { findFallbackCwd as findFallbackCwdShared } from '@main/adapters/shared/find-fallback-cwd';
import { AGENT_ID } from './constants';
import { recoverAndSendImpl } from './recoverer/recover-and-send-impl';
import type { AdapterRecoveryDeliveryOptions } from '@main/adapters/enqueue-idempotency';
import type {
  CaptureRecoveryContinuationThunk,
  CleanupRecoveryContinuationThunk,
  CreateSessionThunk,
  CwdExistsThunk,
  JsonlExistsThunk,
  JsonlMtimeMsThunk,
  LatestConversationMessageTsThunk,
  PrepareRecoveryContinuationThunk,
  RecovererCtx,
  SendMessageThunk,
} from './recoverer/_deps';

// re-export 5 thunk type + 1 ctx interface — caller 仍按
// `import { SessionRecoverer, RecovererCtx, ... } from '@main/adapters/claude-code/sdk-bridge/recoverer'`
// 方式 import (Step 4.4 facade re-export 保 import path byte-identical)。
export type {
  CaptureRecoveryContinuationThunk,
  CleanupRecoveryContinuationThunk,
  CreateSessionThunk,
  CwdExistsThunk,
  JsonlExistsThunk,
  JsonlMtimeMsThunk,
  LatestConversationMessageTsThunk,
  PrepareRecoveryContinuationThunk,
  RecovererCtx,
  SendMessageThunk,
};

// re-export 2 default fn — facade.ctor 默认值 + sdk-bridge.ts:46 import 链兼容
export {
  defaultCwdExists,
  defaultResumeJsonlMtimeMs,
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
    private readonly jsonlMtimeMsThunk: JsonlMtimeMsThunk,
    /**
     * CHANGELOG_99：cwd 存在性探测 thunk(test seam)。facade 内部转发给 protected
     * cwdExists 方法,默认走 fs.existsSync。
     */
    private readonly cwdExistsThunk: CwdExistsThunk,
    private readonly latestConversationMessageTsThunk: LatestConversationMessageTsThunk,
    private readonly captureRecoveryContinuation: CaptureRecoveryContinuationThunk,
    private readonly prepareRecoveryContinuation: PrepareRecoveryContinuationThunk,
    private readonly cleanupRecoveryContinuation: CleanupRecoveryContinuationThunk,
  ) {}

  /**
   * 断连自愈 + 单飞复用 — Step 4.4 拆完后 thin delegate to `recoverAndSendImpl`。
   * 详 `recover-and-send-impl.ts` jsdoc 与 callsite 约束保留。
   */
  async recoverAndSend(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AdapterRecoveryDeliveryOptions,
  ): Promise<string> {
    return recoverAndSendImpl(sessionId, text, attachments, options, {
      ctx: this.ctx,
      createThunk: this.createThunk,
      sendThunk: this.sendThunk,
      jsonlExistsThunk: this.jsonlExistsThunk,
      jsonlMtimeMsThunk: this.jsonlMtimeMsThunk,
      cwdExistsThunk: this.cwdExistsThunk,
      latestConversationMessageTsThunk: this.latestConversationMessageTsThunk,
      captureRecoveryContinuation: this.captureRecoveryContinuation,
      prepareRecoveryContinuation: this.prepareRecoveryContinuation,
      cleanupRecoveryContinuation: this.cleanupRecoveryContinuation,
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
   * - inner jsonl missing context restored / instruction-only
   * - inner cwdFellBack context restored / instruction-only
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
   * Recover a missing cwd by finding its nearest safe existing parent. The shared helper refuses
   * the home directory, its ancestors, and the filesystem root. Tests may override this facade seam.
   */
  protected findFallbackCwd(badCwd: string): string | null {
    return findFallbackCwdShared(badCwd, this.cwdExistsThunk);
  }
}
