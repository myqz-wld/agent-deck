/**
 * Phase 4 Step 4.3 共享 types — createSession 拆分 (orchestrator + 3 子段) 类型层。
 *
 * **拆分布局**（与 hand-off-session / archive-plan-impl 同款 facade pattern）：
 * - `create-session-impl.ts` orchestrator: try/catch + prepare inline + 调度 validate/resume/new
 * - `create-session-validate.ts`: prompt empty/cap + sid 分配 + token allocate
 * - `create-session-resume.ts`: resume path (thread_id 已知)
 * - `create-session-new.ts`: new path (tempKey 占位等 thread.started)
 *
 * **避免循环依赖**: facade `index.ts` import 本 _deps.ts (types only) + create-session-impl.ts
 * (orchestrator) → 子段 fn 调 facade method 通过 `CreateSessionDeps` thunk 注入(ensureCodex)
 * + 直接持 ref (sessions / codexBySession / threadLoop / emit)。子段之间不互调,
 * 通过 orchestrator 串联 + 函数式 return value 传 ctx。
 *
 * **CreateSessionOpts SSOT**: facade.createSession 用 `opts: CreateSessionOpts` 直接消费本 type,
 * 字段 jsdoc 单源在本文件 — 改 facade method 必须改本 type 反之亦然。
 */
import type { HandOffMetadata, UploadedAttachmentRef } from '@shared/types';
import type {
  CodexBridgeOptions,
  CodexSessionHandle,
  InternalSession,
} from '../types';
import type { CodexAppServerClient, CodexAppServerThread } from '../../app-server/client';
import type { ThreadLoop } from '../thread-loop';

export type CodexSandboxMode = 'workspace-write' | 'read-only' | 'danger-full-access';

/**
 * createSession opts (facade `CodexSdkBridge.createSession` 参数 type SSOT)。
 *
 * 字段 jsdoc 单源在本 interface;facade method 用 `opts: CreateSessionOpts` 引用。
 */
export interface CreateSessionOpts {
  cwd: string;
  prompt?: string;
  /** 传 thread_id 表示恢复历史会话；codex 从 ~/.codex/sessions/<id>.jsonl 重放 */
  resume?: string;
  /** 首条 user message 的图片附件（IPC 层已落盘到 <userData>/image-uploads/） */
  attachments?: UploadedAttachmentRef[];
  /** 见 types.ts CreateSessionOptions.codexSandbox（per-session 覆盖）。 */
  codexSandbox?: CodexSandboxMode;
  /**
   * plan model-wiring-and-handoff-20260514 Step 2.5：spawn handler 解 agent body frontmatter
   * `model` 字段后传入。**Codex runtime v0.131.0 ThreadOptions.model 已支持 per-thread override**
   * (prompt-asset-review-optimize-20260527 跟进 reviewer-claude HIGH 修法 — 原注释基于
   * Codex runtime 旧版判断为 "不接受 per-thread model override" 已过期):
   * - createSession 透传 model 给 Codex app-server `startThread/resumeThread` 的 ThreadOptions.model
   *   字段 → runtime 真正按 frontmatter 标的 model 跑
   * - 同时 setModel 持久化到 sessions 表(UI / resume 一致 + DB 记账)
   *
   * model 字段未传 → Codex runtime fallback 到 user `~/.codex/config.toml` 顶层 `model` 配置。
   */
  model?: string;
  /**
   * Codex app-server ThreadOptions.modelReasoningEffort passthrough for live spawned sessions.
   */
  modelReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  /**
   * plan cross-adapter-parity-20260515 Phase A Step A.7 / REVIEW_40 R1 reviewer-codex MED-F:
   * caller 透传的 SDK sandbox 额外可写根。**codex SDK 不消费 extra writable roots**
   * (sandboxMode 三档 'workspace-write' / 'read-only' / 'danger-full-access' 控根 sandbox
   * profile,无 extra allowWrite 字段),但本字段仍持久化到 sessions.extra_allow_write 保跨
   * adapter parity 对称(让 SessionRecord 字段在 claude / codex 之间形态一致 + future codex
   * SDK 加支持时零迁移成本)。
   *
   * 与 model 字段语义已差异: model 字段 codex SDK runtime 真生效,extraAllowWrite 仅持久化未生效。
   */
  extraAllowWrite?: readonly string[];
  /**
   * **plan reverse-rename-sid-stability-20260520 §A.4-pre S1 R6 HIGH-R6-1 + R7 HIGH-R7-1 (codex 对称)**:
   * bridge 内部 internal 字段(详 claude bridge create-session/_deps.ts CreateSessionOpts.resumeCliSid
   * jsdoc — REVIEW_105 MED-1 后该处是 7 组合不变量表 SSOT 锚点; facade type 不再声明本字段):
   * - caller 不该传(默认走反查 sessionRepo.cliSessionId 兜底回填)
   * - codex/recoverer.ts:359 + codex/restart-controller.ts caller 显式传 `rec.cliSessionId ?? sessionId`
   */
  resumeCliSid?: string;
  /**
   * **plan reverse-rename-sid-stability-20260520 §A.4-pre S1 R3 HIGH-G + R7 HIGH-R7-1 (codex 对称)**:
   * 'fresh-cli-reuse-app' 让 jsonl-missing fallback 路径显式触发 SDK fresh thread + 复用 applicationSid。
   */
  resumeMode?: 'resume-cli' | 'fresh-cli-reuse-app';
  /**
   * plan codex-handoff-team-alignment-20260518 §P3 Step 3.5 + §不变量 6 (v4 修订):
   * codex SDK startThread/resumeThread `approvalPolicy` 透传。
   *
   * **P5 Round 1 reviewer-codex M1 修法 (clarify 不变量 6 边界)**：
   * bridge 层 fallback `?? 'never'` 是 **in-process 安全基线**(主进程跑 codex SDK 无 UI 应答
   * approval 弹窗,'on-request' 会让子进程挂死等审批)— 与 networkAccessEnabled /
   * additionalDirectories 两个 reviewer-* runtime default **语义不同**。sandboxMode 不再是
   * reviewer 专属 default,而是走普通 caller 显式 / same-adapter 继承 / target default 链。
   *
   * **不变量 6 修订理解**：
   * - 2 字段 `networkAccessEnabled / additionalDirectories` reviewer-* 专属 spread
   *   (普通 codex session lead 路径**不**应注入,options-builder narrowToCodexOpts 守门)
   * - 1 字段 `approvalPolicy` **所有 codex session 共享**'never' 基线,bridge 兜底 + options-builder
   *   reviewer-* 路径冗余设置(都为 'never',无 contention)。caller 显式传 'on-request' 仅在 codex CLI
   *   外部进程上下文有意义,本 in-process bridge 不支持。
   *
   * options-builder 端 reviewer-* 仍写 'never'(与 bridge fallback 一致,显式 + 防 caller 误传)。
   */
  approvalPolicy?: 'never' | 'on-request';
  /**
   * plan §P3 Step 3.5 + §不变量 6: codex SDK startThread `networkAccessEnabled` 透传。
   * bridge 不主动 enforce default — undefined 沿用 SDK 默认；options-builder 在 reviewer-*
   * 路径下 spread true 让 reviewer 跨网络访问稳定（reviewer-codex web search /
   * reviewer-claude wrapper 内 claude SDK fetch 工具）。
   */
  networkAccessEnabled?: boolean;
  /**
   * plan §P3 Step 3.5 + §不变量 6: codex SDK startThread `additionalDirectories` 透传，
   * 让 codex sandbox=workspace-write 档位额外允许的可读写根。bridge 不主动 enforce default —
   * undefined 沿用 SDK 默认（无额外路径）；options-builder 在 reviewer-* 路径下 spread
   * `['~/.claude', '~/.codex', '/tmp']`（options-builder.ts:176-180 SSOT;`/tmp` 供
   * reviewer-claude wrapper Bash 模板写 `/tmp/<basename>.{in,out,err}.txt` 路由 stdio,
   * spike4 实证缺 `/tmp` 时 codex sandbox-exec 拒读 wrapper 输出）。
   */
  additionalDirectories?: readonly string[];
  /**
   * plan §P3 Step 3.5 + §D1 ADR §(c) per-session env 增量字段：merge 到 codex 子进程
   * envOverride 末尾（优先级最高，与 caller / options-builder spread 一致）。bridge 不主动
   * enforce default — undefined / 空 object 不新增字段;generic 透传机制(目前无 hot caller —
   * reviewer-claude wrapper 路径已改 cross-adapter native 删除;字段保留供未来 caller 重用)。
   *
   * 注入路径：ensureCodex 接收 envOverrideExtra 参数后 `Object.assign(envOverride,
   * opts.envOverrideExtra ?? {})`（后写覆盖前写，options-builder spread 字段最终生效）。
   */
  envOverrideExtra?: Readonly<Record<string, string>>;
  /**
   * plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.2 第 9 步 internal plumbing
   * (codex 端镜像 claude bridge createSession opts.handOff):hand-off cold-start prompt
   * metadata。spawn 主路径 first user message emit 时 spread 进 events.payload(thread-loop
   * fallback :91-99 + success :166-173 + 本 bridge resume :510-516 共 3 处)。
   * 详 HandOffMetadata jsdoc + plan §不变量 5。caller 不该传。
   */
  handOff?: HandOffMetadata;
  /**
   * REVIEW_58 HIGH ✅ (deep-review 双方共识真问题修法 — 对称 claude createSession opts):
   * 跳过本 createSession resume path 内 emit 首条 user message。
   *
   * **触发场景**:recoverer.recoverAndSend 入口已 emit user message(与 live 主路径
   * `sendMessage if(s)` 时机对称),调 createThunk 时显式传 true 让 resume path 跳过 emit。
   *
   * **caller 不该传**(默认 false / undefined):spawn 主路径 / IPC AdapterCreateSession
   * 走此路径,resume path emit user message 让 UI 活动流看到「你」发的第一条话。
   *
   * **不影响 new path emit user message**(由 thread-loop 内 fallback / success 2 处自己 emit) —
   * 仅控制本 createSession resume path emit user message 这一动作。
   */
  skipFirstUserEmit?: boolean;
  /**
   * **REVIEW_99 R3 cancellation-epoch MED 修法 (codex 对称 claude createSession opts)**:recover
   * 路径传 cancelGuard thunk,createSession 内部在 ensureCodex / resumeThread pre-registration await
   * 之后、sessions.set / runTurnLoop 启动**之前**调一次 — 返 true(用户 await 期间再次 close →
   * close-epoch 变 / record 被删)→ throw RecoveryCancelledError(sentinel)abort,不起 fresh thread /
   * 不污染 sessions Map。
   *
   * **caller 不该传**(默认 undefined → 不 gate):spawn 主路径 / IPC AdapterCreateSession / restart
   * 路径都不传。仅 recover 两端(recover-and-send-impl normal-resume createThunk + codex-jsonl-fallback
   * helper 内 createSession)传。sentinel 由 recoverer outer catch / inflight waiter special-case 识别后
   * 静默 abort(不 emit「自动恢复失败」)。详 @main/adapters/shared/recovery-cancelled.ts。
   */
  cancelCheck?: () => boolean;
}

/**
 * createSession 调度所需 deps — facade 注入。
 *
 * - **Map refs**: sessions / codexBySession — 直接持 ref 让子段读写 (与 hand-off-session
 *   团队映射子模块经验同款,函数式 return value 不足以表达 Map mutation 副作用)
 * - **threadLoop**: 直接持 ref,sub-class 实例 lifetime 跟随 facade
 * - **emit**: CodexBridgeOptions emit thunk (event ingest)
 * - **ensureCodex thunk**: 反调 facade.ensureCodex 避免循环依赖 (facade 持 codexBySession 缓存
 *   + 实际 new sdk.Codex 逻辑,本子模块不重复)
 */
export interface CreateSessionDeps {
  readonly sessions: Map<string, InternalSession>;
  readonly codexBySession: Map<string, CodexAppServerClient>;
  readonly threadLoop: ThreadLoop;
  readonly emit: CodexBridgeOptions['emit'];
  /**
   * Lazy 接 facade.ensureCodex 避免 facade ↔ create-session-impl 循环依赖。
   * 通过 arrow 闭包 facade `this` 注入。
   */
  ensureCodex: (
    sessionId: string,
    sessionToken: string,
    envOverrideExtra?: Readonly<Record<string, string>>,
  ) => Promise<CodexAppServerClient>;
}

/**
 * validate phase 输出 — sid + token allocate 结果。
 *
 * orchestrator try block 起头前同步执行(不入 try/catch)— validate throw 时 token 未 allocate
 * 不需要 rollback。
 */
export interface ValidateResult {
  readonly initialSid: string;
  readonly sessionToken: string;
}

/**
 * prepare phase 输出 — codex 实例 + cwd + sandbox + thread + internal session record。
 *
 * orchestrator try block 内执行 — prepare throw (ensureCodex / resumeThread / startThread 等)
 * 走 catch 触发 runCreateSessionRollback (token + codexBySession + sessions + sdkClaim cleanup)。
 */
export interface PreparedContext {
  readonly cwd: string;
  readonly sandboxMode: CodexSandboxMode;
  readonly thread: CodexAppServerThread;
  readonly internal: InternalSession;
}

/**
 * resume / new path 共同输出 — public handle。
 *
 * 与 facade.createSession return type byte-identical (CodexSessionHandle re-export from ../types)。
 */
export type CreateSessionResult = CodexSessionHandle;
