/**
 * Phase 4 Step 4.3 共享 types — recoverer 拆分 (facade + recover-and-send-impl + jsonl-discovery)。
 *
 * **拆分布局**（与 create-session/ 同款 facade pattern）:
 * - `recover-and-send-impl.ts`: recoverAndSend method body (单飞 + cwd fallback + jsonl fallback +
 *   resume / fallback + emit user message)
 * - `jsonl-discovery.ts`: defaultCodexResumeJsonlExists / findThreadJsonlByRecursiveScan /
 *   defaultCwdExists 3 module-level helper (facade re-export)
 * - `_deps.ts` (本文件): SessionRecoverer ctor 注入的 ctx + 4 thunk type
 *
 * **避免循环依赖**: recover-and-send-impl 通过 deps interface 拿 ctx (recovering Map +
 * emit + placeholderEmittedAt Map) + 5 thunk (createThunk / sendThunk / jsonlExistsThunk /
 * cwdExistsThunk / findFallbackCwd)。facade method 是 thin wrapper delegate。
 *
 * **codex 与 claude 差异**(架构内禀):
 * - codex 无 hook 通道:不调 sessionManager.expectSdkSession (claude 走 hook 路径需要)
 * - missing native history uses the shared immutable-spool continuation engine through injected
 *   capture/prepare/cleanup seams; native resume never invokes preparation.
 * - codex 不支持 implicit fork:spike-A2 实测 codex CLI resume 永远返回同 thread_id
 *   (recoverer 仍保 post-rename 防御 `if newRealId !== sessionId` future-proof)
 * - codex jsonl 路径与 claude 不同:`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TIMESTAMP>-<thread_id>.jsonl`
 *   预检算法见 `jsonl-discovery.defaultCodexResumeJsonlExists`
 */
import type { UploadedAttachmentRef, SessionRecord } from '@shared/types';
import type { CodexThinkingLevel } from '@shared/session-metadata';
import type { CodexBridgeOptions, CodexSessionHandle } from '../types';
import type {
  CapturedRecoveryContinuation,
  PreparedRecoveryContinuation,
  RecoveryRuntimeOverrides,
} from '@main/session/continuation-context/recovery';
import type { TrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import type { AgentEnqueueOptions } from '@main/adapters/types';

/** 5s dedup 窗口防同 sessionId 短时间内多次 recover 重 emit「⚠ Codex 通道已断开」噪声。 */
export const PLACEHOLDER_DEDUP_MS = 5_000;

export interface RecovererCtx {
  /**
   * **SHARED** with restartController.recovering（symmetry-plan P2 HIGH-A 已加 facade 持权威 ref）。
   * 单飞 invariant：同 sessionId 同时只有一条 recovery / restart in-flight。
   */
  readonly recovering: Map<string, Promise<unknown>>;
  readonly emit: CodexBridgeOptions['emit'];
}

export type CreateSessionThunk = (opts: {
  cwd: string;
  prompt?: string;
  /** Main-only branded recovery turn. Never accepted from renderer/public adapter options. */
  trustedContinuation?: TrustedContinuationInitialTurn;
  resume?: string;
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
  attachments?: UploadedAttachmentRef[];
  /**
   * recoverer fallback / resume 路径显式透传 spawn 时持久化的 model（与 claude
   * `recoverer.ts` HIGH-1 同款修法 — fallback 路径不走 resume 时若不显式透传，
   * 已 spawn 的 codex 实际跑默认 model 而 DB record 仍显示原 model）。
   *
   * Codex runtime v0.131.0+ ThreadOptions.model 已支持 per-thread override(prompt-asset-review-optimize-20260527
   * 修订:原"codex SDK 不接受 per-thread model override"判断已过期), createSession spread
   * 进 ThreadOptions runtime 真切 model + setModel 持久化让 UI / resume / dormant 唤醒一致。
   */
  model?: string;
  /** Persisted Codex reasoning level restored on native resume and fresh-thread recovery. */
  modelReasoningEffort?: CodexThinkingLevel;
  /**
   * plan cross-adapter-parity-20260515 Phase A Step A.7 / REVIEW_40 R1 reviewer-codex MED-F:
   * recoverer fallback / resume 路径显式透传 spawn 时持久化的 SDK sandbox 额外可写根。
   *
   * 与 model 字段已不同款(prompt-asset-review-optimize-20260527 修订:Codex runtime v0.131.0+
   * ThreadOptions.model 已 runtime 真生效,extraAllowWrite 仍未生效):codex SDK 不消费 extra
   * writable roots(sandboxMode 三档无 allowWrite 字段),但 createSession 内部仍 setExtraAllowWrite
   * 持久化保 parity 对称 — 保留入参字段对齐 claude 接口形态。**透传到当前不消费的 opts 无副作用**
   * (persistSessionFields 内 if 卫语句 skip 空数组,setExtraAllowWrite null 也是合法值)。
   *
   * 修法理由(plan §4 推荐 ✅ 做):即使 codex bridge 当前不消费,持久化字段 + 读回保 parity 完整,
   * future codex SDK 加支持时零迁移成本 + 减跨 adapter 漂移。与 codexSandbox / claudeCodeSandbox
   * 同样走显式透传 + ?? undefined 兜底(rec.extraAllowWrite 历史 NULL 时 undefined 跳过 setter)
   * — 不同于 model 字段(Codex runtime v0.131.0+ 真生效),本字段 runtime 不消费仅持久化。
   */
  extraAllowWrite?: readonly string[];
  /**
   * plan codex-recover-network-dirs-parity-20260602：recover 路径显式透传 spawn 时持久化的
   * `networkAccessEnabled`（rec.networkAccessEnabled ?? undefined）。**与 extraAllowWrite 不同：
   * codex SDK runtime 真消费** —— recover 重建 thread 时不透传 → SDK 走默认无网络 → reviewer-codex
   * 失去 web search。这是本字段加进 thunk 的**唯一类型瓶颈**（facade CreateSessionOpts 已有此字段，
   * bridge createSession(opts) 整体透传 createSessionImpl 无白名单丢弃）。
   */
  networkAccessEnabled?: boolean;
  /**
   * plan codex-recover-network-dirs-parity-20260602：recover 路径显式透传 spawn 时持久化的
   * `additionalDirectories`（rec.additionalDirectories ?? undefined）。codex SDK runtime 真消费
   * （配合 networkAccessEnabled），recover 不透传 → reviewer-codex 失去跨目录读 plan/config + /tmp。
   */
  additionalDirectories?: readonly string[];
  /**
   * **plan reverse-rename-sid-stability-20260520 §A.4-pre S1 R6 HIGH-R6-1 + R7 HIGH-R7-1 (codex 对称)**:
   * caller 显式传 cli sid (rec.cliSessionId ?? sessionId) 让 codex SDK resumeThread 拿正确 thread sid。
   */
  resumeCliSid?: string;
  /**
   * **plan reverse-rename-sid-stability-20260520 §A.4-pre S1 R3 HIGH-G + R7 HIGH-R7-1 (codex 对称)**:
   * 'fresh-cli-reuse-app' 让 jsonl-missing fallback 路径显式触发 SDK fresh thread + 复用 applicationSid。
   */
  resumeMode?: 'resume-cli' | 'fresh-cli-reuse-app';
  /**
   * REVIEW_58 HIGH ✅ (deep-review 双方共识真问题修法 — 对称 claude recoverer.ts):
   * 跳过 createSession 内 emit 首条 user message — 让 caller 收口 emit 责任避免双气泡。
   *
   * **触发场景**:recoverer.recoverAndSend 入口已 emit user message(与 live 主路径
   * `index.ts:778-793` sendMessage `if (s)` 路径对称),调 createThunk 时显式传 true 让
   * createSession resume path (`index.ts:539-556`) 跳过重复 emit。
   *
   * **不传 / false** = 默认 emit user message(spawn 主路径 / IPC AdapterCreateSession
   * 走此路径,resume path 必须 emit user message 让 UI 活动流看到「你」发的第一条话)。
   */
  skipFirstUserEmit?: boolean;
  /** Preserve keyed/deferred queue semantics when this prompt is the recovery create's first turn. */
  initialEnqueueOptions?: AgentEnqueueOptions;
  /**
   * **REVIEW_99 R3 cancellation-epoch MED 修法 (codex 对称 claude)**:recover 路径透传 cancelGuard,
   * createSession 内部 ensureCodex / resumeThread pre-registration 到 sessions.set 之间查一次 epoch,
   * 变了 throw RecoveryCancelledError abort。详 codex CreateSessionOpts.cancelCheck jsdoc。restart /
   * spawn / IPC 不传。
   */
  cancelCheck?: () => boolean;
}) => Promise<CodexSessionHandle>;

export type SendMessageThunk = (
  sessionId: string,
  text: string,
  attachments?: UploadedAttachmentRef[],
) => Promise<void>;

/**
 * jsonl 探测 thunk(test seam)。签名与 claude `JsonlExistsThunk` 形态对齐但参数不同：
 * - claude 用 (cwd, sessionId) — jsonl 路径含 encoded cwd
 * - codex 用 (threadId, startedAt) — jsonl 路径含 createdAt 日期段
 *
 * 默认实现 `defaultCodexResumeJsonlExists` 走 fs.readdirSync 扫 startedAt 日期目录。
 * Test 通过 facade extend override 让单测不依赖真 ~/.codex/sessions 目录。
 */
export type JsonlExistsThunk = (threadId: string, startedAt: number) => boolean;

/** cwd 存在性 thunk(test seam)。默认 fs.existsSync。test 通过 facade extend override。 */
export type CwdExistsThunk = (cwd: string) => boolean;

/**
 * findFallbackCwd thunk — 让 recover-and-send-impl 注入启发式 fallback。
 *
 * facade SessionRecoverer 持 protected findFallbackCwd method (test override 注入点),
 * sub-module 通过 thunk 反调避免循环依赖。
 */
export type FindFallbackCwdThunk = (badCwd: string) => string | null;

/** Synchronous immutable TEMP-spool capture. Must finish before the current recovery event emits. */
export type CaptureRecoveryContinuationThunk = (
  session: SessionRecord,
  overrides?: RecoveryRuntimeOverrides,
) => CapturedRecoveryContinuation;

/** Shared provider-neutral checkpoint/raw-tail recovery preparation. */
export type PrepareRecoveryContinuationThunk = (
  capture: CapturedRecoveryContinuation,
  continuationInstruction: string,
) => Promise<PreparedRecoveryContinuation>;

/** Best-effort/idempotent TEMP-spool cleanup. */
export type CleanupRecoveryContinuationThunk = (
  capture: CapturedRecoveryContinuation,
) => void;

/** Dependencies injected into the recovery implementation by the thin facade. */
export interface RecoverAndSendDeps {
  readonly ctx: RecovererCtx;
  readonly placeholderEmittedAt: Map<string, number>;
  readonly createThunk: CreateSessionThunk;
  readonly sendThunk: SendMessageThunk;
  readonly jsonlExistsThunk: JsonlExistsThunk;
  readonly cwdExistsThunk: CwdExistsThunk;
  readonly findFallbackCwd: FindFallbackCwdThunk;
  readonly captureRecovery: CaptureRecoveryContinuationThunk;
  readonly prepareRecovery: PrepareRecoveryContinuationThunk;
  readonly cleanupRecovery: CleanupRecoveryContinuationThunk;
}
