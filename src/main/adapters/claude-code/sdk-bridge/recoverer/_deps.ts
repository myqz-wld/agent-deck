/**
 * SessionRecoverer SSOT types & ctx interfaces — Step 4.4 拆分共享层。
 *
 * **抽出动机**（参照 Step 4.3 codex 端 recoverer/_deps.ts 同款模式）：
 * facade `recoverer.ts` SessionRecoverer.recoverAndSend 巨型 method ~326 LOC 拆完后,
 * RecovererCtx + 5 thunk type signatures + PLACEHOLDER_DEDUP_MS const 抽到本 SSOT。
 * recover-and-send-impl 子模块 import 时仅依赖本 SSOT,不撞 facade class 循环 import。
 *
 * **本文件覆盖范围**：
 * - `RecovererCtx` — facade 注入的 ctx ref（recovering Map SHARED + emit thunk）
 * - recovery lifecycle and provider-history probe thunk signatures
 *
 * **不变量保留**：所有原 inline jsdoc 字面 carry over（REVIEW_36 HIGH-1 sandbox 透传 /
 * REVIEW_58 HIGH skipFirstUserEmit / plan reverse-rename-sid-stability §A.4-pre S1 R6+R7 /
 * cross-adapter-parity §Phase A.6 等 jsdoc 不删不改）。
 */
import type { SessionRecord, UploadedAttachmentRef } from '@shared/types';
import type { SdkBridgeOptions, SdkSessionHandle } from '../types';
import type {
  CapturedRecoveryContinuation,
  PreparedRecoveryContinuation,
  RecoveryRuntimeOverrides,
} from '@main/session/continuation-context/recovery';
import type { TrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import type { AgentEnqueueOptions } from '@main/adapters/types';

/**
 * facade `recoverer.ts` SessionRecoverer ctor 注入的 ctx ref bundle。
 *
 * **State 所有权**：
 * - `recovering` Map — **SHARED**，与 lifecycle.restartWithPermissionMode 双方读写同一份
 *   单飞表（CHANGELOG_26）。原 plan 错把它当 recoverer 独占，F2 finding 修法：
 *   提到 facade 持有 → ctx 注入。
 * - `emit` — facade.opts.emit thunk
 */
export interface RecovererCtx {
  /**
   * **SHARED** with lifecycle.restartWithPermissionMode（F2 修法）。
   * 单飞 invariant：同 sessionId 同时只有一条 recovery / restart in-flight。
   */
  readonly recovering: Map<string, Promise<unknown>>;
  readonly emit: SdkBridgeOptions['emit'];
}

/**
 * createSession thunk（test seam）— recoverer 调用 facade.createSession 走 ctor 注入。
 *
 * 字段 jsdoc 字面 carry over from 原 recoverer.ts:54-131 inline CreateSessionThunk type。
 */
export type CreateSessionThunk = (opts: {
  cwd: string;
  prompt?: string;
  trustedContinuation?: TrustedContinuationInitialTurn;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  resume?: string;
  teamName?: string;
  attachments?: UploadedAttachmentRef[];
  /**
   * REVIEW_36 HIGH-1：recoverer fallback 路径（jsonl missing / cwdFellBack）显式透传 sandbox 档位。
   *
   * 修前漏洞：fallback 不走 resume → resolveClaudeSandboxMode 拿 opts.resume=undef + opts.claudeCodeSandbox=undef
   * → 走 settings 全局 fallback → SDK 子进程 spawn 时按全局值装载沙盒，**与历史 record 持久化的
   * `sessionRepo.claudeCodeSandbox` 无关**。后续 renameSdkSession(OLD, NEW) 把 fromRow.claude_code_sandbox 覆盖到
   * NEW row 让 DB 字段看起来正确，但**已 spawn 的 SDK 进程已无法改沙盒**（spawn-time 锁定）。
   *
   * 用户场景：strict 档历史会话 + jsonl 丢失 → fallback 后 SDK 子进程落到全局沙盒档位（DB 仍显示 strict），
   * 历史会话的安全语义静默降级。
   */
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict';
  /**
   * plan model-wiring-and-handoff-20260514 Step 2.4：recoverer fallback / resume 路径显式透传
   * spawn 时持久化的 model（来源:spawn handler 解 frontmatter `model` 字段）。
   *
   * 修前漏洞：fallback 路径不走 resume → resolveClaudeModel 拿 opts.resume=undef +
   * opts.model=undef → 返回 undefined → SDK 用 ANTHROPIC_MODEL env / 默认 model；
   * **与历史 record 持久化的 sessionRepo.model 无关**。后续 renameSdkSession(OLD, NEW) 把
   * fromRow.model 覆盖到 NEW row 让 DB 字段看起来正确，但**已 spawn 的 SDK 进程已用错
   * model**（query options 锁定后无法切）。
   *
   * 用户场景：reviewer-claude opus 历史会话 + lead 主模型 sonnet + jsonl 丢失 → fallback 后
   * reviewer SDK 子进程实际跑 sonnet（DB 仍显示 opus），异构对抗强度静默降级。
   */
  model?: string;
  /**
   * plan cross-adapter-parity-20260515 Phase A Step A.6 / REVIEW_40 R1 reviewer-codex MED-F:
   * recoverer fallback / resume 路径显式透传 spawn 时持久化的 SDK sandbox 额外可写根。
   *
   * 修前漏洞:fallback 路径不走 resume → createSession opts.extraAllowWrite=undef →
   * buildSandboxOptions 走默认值 sandbox.allowWrite=[cwd, /tmp, ~/.cache];
   * **与历史 record 持久化的 sessionRepo.extraAllowWrite 无关**(此前 sessions.extra_allow_write
   * 列不存在 → 透传断点 → app 重启后 mainRepo 写权限丢失)。本字段实现 jsdoc 承诺的
   * 「recoverer 从 sessionRepo 读回」语义,与 claudeCodeSandbox / model 同款显式透传 + ?? undefined
   * 兜底(rec.extraAllowWrite 历史 NULL 时让 buildSandboxOptions 走默认)。
   *
   * 用户场景:hand_off_session 外置 worktree(cwd=worktreePath 不在 mainRepo subtree)+ caller
   * 传 [mainRepo] 让 session 能写 mainRepo plan 文件。app 重启 / sdk-bridge state lost /
   * recoverer fallback 路径不读回 → SDK sandbox.allowWrite 不含原 mainRepo → 写 plan 文件
   * 静默失败(sandbox 拦)→ 用户体感 plan 完成时 frontmatter 更新失败莫名其妙。
   */
  extraAllowWrite?: readonly string[];
  /**
   * **plan reverse-rename-sid-stability-20260520 §A.4-pre S1 R6 HIGH-R6-1 + R7 HIGH-R7-1**:
   * caller 显式传 cli sid 让 SDK CLI `--resume` 找正确 jsonl + S6 fork detect 不 short-circuit。
   * 详 create-session/_deps.ts CreateSessionOpts.resumeCliSid jsdoc (REVIEW_105 MED-1 SSOT 锚点)。
   */
  resumeCliSid?: string;
  /**
   * **plan reverse-rename-sid-stability-20260520 §A.4-pre S1 R3 HIGH-G + R7 HIGH-R7-1**:
   * 'fresh-cli-reuse-app' 让 jsonl-missing fallback 路径显式触发 SDK fresh CLI thread + 复用
   * applicationSid (不创建新 sessions row,走 sessionManager.updateCliSessionId 黑名单链)。
   * 详 create-session/_deps.ts CreateSessionOpts.resumeMode jsdoc 7 种合法/非法组合 (REVIEW_105 MED-1 SSOT 锚点)。
   */
  resumeMode?: 'resume-cli' | 'fresh-cli-reuse-app';
  /**
   * REVIEW_58 HIGH ✅ (deep-review 双方共识真问题修法):跳过 finalizeSessionStart 内 emit
   * 首条 user message — 让 caller 收口 emit 责任避免双气泡。
   *
   * **触发场景**:recoverer.recoverAndSend 入口已 emit user message(与 live 主路径
   * `index.ts:520-535` 时机对称),调 createThunk 时显式传 true 让下游 finalize 跳过重复 emit。
   *
   * **不传 / false** = 默认 emit user message(spawn 主路径 / IPC AdapterCreateSession 走此路径,
   * 首条 prompt 没经过 sendMessage emit user message 路径,必须由 finalize 补 emit)。
   *
   * **不影响 attachments / handOff / model / sandbox 持久化等其他 finalize 副作用** —
   * 仅控制 emit user message 这一动作。
   */
  skipFirstUserEmit?: boolean;
  /** Preserve keyed/deferred queue semantics when this prompt is the recovery create's first turn. */
  initialEnqueueOptions?: AgentEnqueueOptions;
  /**
   * **REVIEW_99 R3 cancellation-epoch MED 修法**:recover 路径透传 cancelGuard,createSession 内部
   * pre-registration await 后 sessions.set 前查一次 epoch,变了 throw RecoveryCancelledError abort。
   * 详 ClaudeCreateOpts.cancelCheck jsdoc(create-session/_deps.ts)。restart / spawn / IPC 不传。
   */
  cancelCheck?: () => boolean;
}) => Promise<SdkSessionHandle>;

export type CaptureRecoveryContinuationThunk = (input: {
  session: SessionRecord;
  overrides?: RecoveryRuntimeOverrides;
}) => CapturedRecoveryContinuation;

export type PrepareRecoveryContinuationThunk = (input: {
  capture: CapturedRecoveryContinuation;
  continuationInstruction: string;
  signal?: AbortSignal;
}) => Promise<PreparedRecoveryContinuation>;

export type CleanupRecoveryContinuationThunk = (
  capture: CapturedRecoveryContinuation,
) => void;

/**
 * HIGH-1 修法：sendThunk 三参签名，attachments 透传到第二条等待者。
 *
 * 原 plan 漏点：`return this.sendThunk(sessionId, text)` 把 attachments 静默吞掉，
 * 第二条带图的 user message 在 inflight 等待者路径下变纯文本。
 *
 * 透传约束：
 * - 第一条 inflight 的 attachments 走 createThunk（携带 prompt + attachments）
 * - 第二条等待者的 attachments 走 sendThunk（独立 attachments path 集合）
 * - 两条之间不复用 / 不去重，文件路径完全独立（IPC 层为每条 message 各写一批）
 */
export type SendMessageThunk = (
  sessionId: string,
  text: string,
  attachments?: UploadedAttachmentRef[],
) => Promise<void>;

export type JsonlExistsThunk = (cwd: string, sessionId: string) => boolean;

/**
 * Claude Code CLI resume jsonl 的 mtime 探测 thunk(test seam)。
 *
 * 返回 epoch ms；文件不存在 / stat 失败 / 权限异常返回 null。read-side 幻影 fork 自愈只在
 * applicationSid.jsonl 存在且 mtime 足够新时才 resume applicationSid，避免真实 fork 当前
 * cli jsonl 缺失时误用旧 applicationSid.jsonl 回退上下文。
 */
export type JsonlMtimeMsThunk = (cwd: string, sessionId: string) => number | null;

/**
 * CHANGELOG_99：cwd 存在性 thunk(test seam)。默认实现走 node fs `existsSync`,
 * test 通过 facade extend override 让单测不依赖真 fs。
 */
export type CwdExistsThunk = (cwd: string) => boolean;

/** Latest valid dialog time used to validate phantom-resume jsonl freshness. */
export type LatestConversationMessageTsThunk = (sessionId: string) => number | null;

/**
 * `findFallbackCwd` thunk — facade extend override 注入点。
 *
 * recoverAndSend impl 通过本 thunk 调用 facade.findFallbackCwd protected method（test
 * 子类化 facade override 改启发式）。free fn 化后通过 thunk 间接调用避免循环 import。
 */
export type FindFallbackCwdThunk = (badCwd: string) => string | null;

/**
 * `emitFallbackMessage` thunk — facade private method 通过 ctor 注入暴露给 free fn impl。
 *
 * recoverAndSend impl 6 处调用本 thunk emit cwd missing throw / cwd fallback info /
 * jsonl missing summary used / skipped / cwdFellBack summary used / skipped builder 文案。
 * facade `recoverer.ts` SessionRecoverer.emitFallbackMessage 留 class 内做 ctx.emit 收口，
 * 通过 ctor bind 注入本 thunk（user Q3 confirm 推荐方案）。
 */
export type EmitFallbackMessageThunk = (
  sessionId: string,
  text: string,
  opts?: { error?: boolean },
) => void;

/**
 * `recoverAndSendImpl` free fn deps bundle — facade `recoverer.ts` SessionRecoverer
 * class 内 7 ctor field + 1 placeholderEmittedAt Map + 1 findFallbackCwd protected method
 * 一次性通过本 interface 注入。
 *
 * **抽出动机**（参照 Step 4.3 codex 端 RecovererDeps 同款模式）：让 free fn
 * `recoverAndSendImpl` 签名简洁 — 7+ thunk 不展开成 7+ 入参，统一一个 deps bundle。
 */
export interface RecoverAndSendDeps {
  readonly ctx: RecovererCtx;
  readonly createThunk: CreateSessionThunk;
  readonly sendThunk: SendMessageThunk;
  readonly jsonlExistsThunk: JsonlExistsThunk;
  readonly jsonlMtimeMsThunk: JsonlMtimeMsThunk;
  readonly cwdExistsThunk: CwdExistsThunk;
  readonly latestConversationMessageTsThunk: LatestConversationMessageTsThunk;
  readonly captureRecoveryContinuation: CaptureRecoveryContinuationThunk;
  readonly prepareRecoveryContinuation: PrepareRecoveryContinuationThunk;
  readonly cleanupRecoveryContinuation: CleanupRecoveryContinuationThunk;
  readonly findFallbackCwdThunk: FindFallbackCwdThunk;
  readonly emitFallbackMessageThunk: EmitFallbackMessageThunk;
  /**
   * facade `recoverer.ts` SessionRecoverer.placeholderEmittedAt — recoverer 独占 Map。
   *
   * REVIEW_17 R3 / M3-R3：5s dedup 窗口防同 sessionId 短时间内反复 recover 重 emit
   * 多条「⚠ SDK 通道已断开...」噪声。facade class 持有 Map 的 ref，free fn impl
   * 通过 deps 注入 mutate 同一 Map（key insert / delete 过期 entry 都在 free fn 内做）。
   */
  readonly placeholderEmittedAt: Map<string, number>;
}
