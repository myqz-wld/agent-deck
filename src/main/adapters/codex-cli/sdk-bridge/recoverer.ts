/**
 * SessionRecoverer — codex 端断连自愈 + jsonl 兜底（symmetry-plan P2 HIGH-B + MED-E + LOW-A）。
 *
 * 镜像 claude `claude-code/sdk-bridge/recoverer.ts` 同款架构，**精简版**：
 * - Claude and Codex both use the provider-neutral continuation engine for missing history
 * - codex 1.0 (Phase 4 Step 4.3 拆分后 facade ~120 LOC + recover-and-send-impl ~280 LOC +
 *   jsonl-discovery ~120 LOC + _deps ~150 LOC，无摘要 prepend / 无 hook 通道)
 *
 * **抽出动机**（R1 reviewer-claude 主题 C HIGH 双方独立 + lead 实证）：
 * 修前 codex `sendMessage` 缺 sessions Map 时直接 `throw new Error('session ${sid} not found')`。
 * app 重启 / dev mode vite hot reload / main process crash 重生 → 内存 sessions Map 空 →
 * 用户在 SessionDetail 输入消息 → renderer 报错红字，**不能继续聊**（必须新建会话，丢上下文）。
 * claude 端走 recoverer 自愈占位 + resume + 体感「掉线但又续上了」，codex 完全缺这条路径。
 *
 * **Phase 4 Step 4.3 拆分布局**:
 * - 本 facade ~120 LOC: SessionRecoverer class shell + thin recoverAndSend delegate +
 *   findFallbackCwd protected method (test override 注入点)
 * - `recoverer/_deps.ts`: RecovererCtx + 4 thunk type + PLACEHOLDER_DEDUP_MS const
 * - `recoverer/recover-and-send-impl.ts`: recoverAndSend method 主体 (~280 LOC)
 * - `recoverer/jsonl-discovery.ts`: 3 helper (defaultCodexResumeJsonlExists / defaultCwdExists /
 *   findThreadJsonlByRecursiveScan)
 *
 * **State 所有权**：
 * - `recovering` Map：**SHARED**，与 facade 持有的同一份 ref（symmetry-plan P2 HIGH-A 已就位），
 *   restartController + recoverer 双方读写同一份单飞表。同 sessionId 同时只有一条 recovery /
 *   restart in-flight。
 * - `placeholderEmittedAt` Map：**recoverer 独占**，5s dedup 同 sessionId 短时间反复 recover
 *   重 emit「⚠ Codex 通道已断开...」噪声（与 claude REVIEW_17 R3 / M3-R3 同款）。
 *
 * **循环依赖回避**（与 claude 同款）：
 * - recoverAndSend 调 facade.createSession（resume / 不带 resume 兜底）→ 走 createThunk
 * - recoverAndSend 调 facade.sendMessage（inflight 等完后递归把第二条 text 正常 push）→ 走 sendThunk
 * - jsonlExistsThunk + cwdExistsThunk 走 thunk 让 test 注入 mock
 *
 * **codex 与 claude 的关键差异**（架构内禀 / SDK 形态）：
 * - codex 无 hook 通道：不调 sessionManager.expectSdkSession（claude 走 hook 路径需要）
 * - jsonl-missing fallback uses the shared provider-neutral continuation engine. Mutable events are
 *   copied to an immutable TEMP spool before the current user event; native jsonl presence bypasses
 *   preparation, while a true miss starts a fresh provider thread under the stable application SID.
 * - codex 不支持 implicit fork：spike-A2 实测 codex CLI resume 永远返回同 thread_id（详
 *   restart-controller line 97 注释）。recoverer 仍保留 post-rename 防御（`if newRealId !== sessionId`）
 *   future-proof 防 SDK 升级 / CLI 行为变更。
 * - codex 无 Claude permissionMode：普通会话沿用 Codex approval policy，并由 app-server
 *   server request bridge 接入 Agent Deck 权限面板。
 * - codex jsonl 路径与 claude 不同：claude 在 `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`，
 *   codex 在 `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TIMESTAMP>-<thread_id>.jsonl`，
 *   pre-check 算法见 `jsonl-discovery.defaultCodexResumeJsonlExists`。
 *
 * **护栏（与 claude 同款）**：
 * - CHANGELOG_26 — recovering 单飞 + 30s placeholder UX
 * - CHANGELOG_28 — jsonl 预检不在则走不带 resume 的新建 createSession + 事后 renameSdkSession
 * - CHANGELOG_31 — 用户显式发消息触发 recoverAndSend 自动 unarchive
 * - REVIEW_17 R3 — 5s placeholder dedup
 * - CHANGELOG_99 — cwd 失效启发式 fallback
 */
import type { UploadedAttachmentRef } from '@shared/types';
import { findFallbackCwd as findFallbackCwdShared } from '@main/adapters/shared/find-fallback-cwd';
import type {
  CreateSessionThunk,
  CwdExistsThunk,
  JsonlExistsThunk,
  RecovererCtx,
  SendMessageThunk,
  CaptureRecoveryContinuationThunk,
  PrepareRecoveryContinuationThunk,
  CleanupRecoveryContinuationThunk,
} from './recoverer/_deps';
import { recoverAndSendImpl } from './recoverer/recover-and-send-impl';
import type { AdapterRecoveryDeliveryOptions } from '@main/adapters/enqueue-idempotency';

export class SessionRecoverer {
  /**
   * 5s dedup 窗口防同 sessionId 短时间反复 recover（与 claude REVIEW_17 R3 同款）。
   */
  private readonly placeholderEmittedAt = new Map<string, number>();

  constructor(
    private readonly ctx: RecovererCtx,
    private readonly createThunk: CreateSessionThunk,
    private readonly sendThunk: SendMessageThunk,
    private readonly jsonlExistsThunk: JsonlExistsThunk,
    private readonly cwdExistsThunk: CwdExistsThunk,
    private readonly captureRecovery: CaptureRecoveryContinuationThunk,
    private readonly prepareRecovery: PrepareRecoveryContinuationThunk,
    private readonly cleanupRecovery: CleanupRecoveryContinuationThunk,
  ) {}

  /**
   * 断连自愈 — facade thin delegate (详 recoverer/recover-and-send-impl.ts §执行序列)。
   *
   * 调度 recoverAndSendImpl free fn,deps interface 注入 class state + 4 thunk:
   * - ctx (recovering + emit) SHARED with facade.restartController
   * - placeholderEmittedAt Map 独占
   * - 4 thunk 直接转发 ctor 注入的 closure
   * - findFallbackCwd 反调本 class protected method (test override 注入点)
   *
   * **plan cross-adapter-parity-20260515 Phase B Step B.2 — 返回 Promise<string>**:
   * 返回 final session id(fallback path 返 newRealId / resume path 返 sessionId)。修前
   * `Promise<void>` waiter 等 inflight 后用 OLD sessionId 调 sendThunk → bridge.sendMessage
   * 内 sessions Map miss → 又进 recoverAndSend → sessionRepo.get(OLD) 已 rename DELETE → throw
   * "not found" — 用户体感「第二条消息消失」(REVIEW_40 R2 reviewer-codex MED parity 限制)。
   */
  async recoverAndSend(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
    options?: AdapterRecoveryDeliveryOptions,
  ): Promise<string> {
    return recoverAndSendImpl(sessionId, text, attachments, options, {
      ctx: this.ctx,
      placeholderEmittedAt: this.placeholderEmittedAt,
      createThunk: this.createThunk,
      sendThunk: this.sendThunk,
      jsonlExistsThunk: this.jsonlExistsThunk,
      cwdExistsThunk: this.cwdExistsThunk,
      // arrow 闭包 this,运行时晚解析 → this.findFallbackCwd 一定已绑定 (test override 注入点)
      findFallbackCwd: (badCwd) => this.findFallbackCwd(badCwd),
      captureRecovery: this.captureRecovery,
      prepareRecovery: this.prepareRecovery,
      cleanupRecovery: this.cleanupRecovery,
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
