/**
 * createSession SSOT types & dep interfaces — Step 4.4 拆分共享层。
 *
 * **抽出动机**（参照 Step 4.3 codex 端 CreateSessionOpts SSOT 抽出经验）：
 * facade ClaudeSdkBridge.createSession 巨型 method ~355 LOC 拆分后,createSession opts
 * 字段(16 字段长 jsdoc)、phase 间传递的派生 state、子模块注入的 facade ref 需要
 * 统一 SSOT 文件让 TS 类型循环引用问题消失 + 子模块独立 unit test 不依赖 facade。
 *
 * **本文件覆盖范围**：
 * - `CreateSessionOpts` — caller 调用 facade.createSession 时的入参 SSOT(原 inline opts type)
 * - `CreateSessionDeps` — sdk-query / impl orchestrator 子模块注入的 facade ref bundle
 * - `PreparedSessionContext` — prepare phase 派生 state（internal / tempKey / canUseTool 等）
 * - `SdkQueryResult` — sdk-query phase 派生 state（realId）
 *
 * **不变量保留**：所有原 inline jsdoc 字面 carry over（plan reverse-rename-sid-stability /
 * REVIEW_36 HIGH-B / cross-adapter-parity Phase A Step A.5 / handoff-render-and-image-batch
 * Phase 2 Step 2.2 / REVIEW_58 HIGH 等 jsdoc 不删不改）。
 */
import type { AgentDefinition, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  HandOffMetadata,
  UploadedAttachmentRef,
} from '@shared/types';
import type { ClaudeCodeEffortLevel } from '@main/adapters/types';
import type { InternalSession, SdkBridgeOptions, SdkSessionHandle } from '../types';
import type { PermissionResponder } from '../permission-responder';
import type { StreamProcessor } from '../stream-processor';

/**
 * facade ClaudeSdkBridge.createSession 入参 SSOT（原 inline opts type）。
 *
 * **plan reverse-rename-sid-stability-20260520 §A.4-pre S1 + handoff-render-and-image-batch
 * §Phase 2 Step 2.2 / REVIEW_58 HIGH ✅ 等 jsdoc 字面 carry over from index.ts:189-256**:
 * 字段 jsdoc 抽出后 caller 仍按本 type 字段语义传参,facade.createSession 改 thin delegate
 * 时入参签名直接复用本 type(不再 inline 重复定义 16 字段长 jsdoc)。
 */
export interface CreateSessionOpts {
  cwd: string;
  prompt?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  /** 传 sessionId 表示恢复历史会话（CLI 会从 ~/.claude/projects/<cwd>/<sid>.jsonl 续上）。 */
  resume?: string;
  /**
   * R3 universal team backend：team_name 仅作 sessionManager.recordCreatedTeamName
   * 入口标签使用，不再触发 Claude CLI 实验特性 env 注入（CHANGELOG_45/46 老路径已 R3.E6 删除）。
   */
  teamName?: string;
  /** 首条 user message 的图片附件（path 由 IPC 层 writeUploadedImage 落盘后传入）。 */
  attachments?: UploadedAttachmentRef[];
  /**
   * CHANGELOG_74：Claude Code OS 沙盒 per-session 覆盖（NewSessionDialog / ComposerSdk
   * 切档传入）。undefined → fallback 链：opts.resume 路径读 sessionRepo.claudeCodeSandbox →
   * settings.claudeCodeSandbox 全局值 → 'off' 兜底。与 codex codexSandbox 字面镜像。
   */
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict';
  /**
   * REVIEW_36 R2 HIGH-B + MED-C：可选额外 writable roots（仅 workspace-write 档生效）。
   * 典型场景：
   * - hand_off_session 外置 worktree（cwd=worktreePath）→ 传 `[mainRepo]` 让 session 能写 mainRepo plan
   * - recoverer cwd fallback → 传 `[原 mainRepo]` 防写权限静默扩大到 fallback 父目录
   */
  extraAllowWrite?: readonly string[];
  /**
   * plan model-wiring-and-handoff-20260514 Step 2.2：SDK / agent model 透传。
   * 来源：spawn handler 解 adapter-native agent config `model` 字段后传入。
   * fallback 链 opts.model > resumed sessionRepo.model > provider profile default > undefined
   * （详 model-resolve.ts）。透传给 SDK `query({ options.model })` 真正生效，并
   * setModel 持久化让 resume / dormant 唤醒后保持一致。
   */
  model?: string;
  /** Bridge profile fallback, applied only after an explicit model and a resumed session model. */
  profileDefaultModel?: string;
  /**
   * Per-session Claude Code thinking / effort override. Passed to SDK `query({ options.effort })`.
   * Undefined preserves user settings / provider defaults.
   */
  claudeCodeEffortLevel?: ClaudeCodeEffortLevel;
  /** Claude Code SDK main-thread agent name passed to query options.agent. */
  claudeAgentName?: string;
  /** Programmatic Claude Code SDK agent definitions keyed by agent name. */
  claudeAgents?: Record<string, AgentDefinition>;
  /**
   * Bridge-internal env overlay for Claude-compatible provider profiles. Not exposed through
   * IPC/MCP raw opts; adapter profiles inject it at bridge.createSession time.
   */
  envOverrideExtra?: Readonly<Record<string, string>>;
  /**
   * **plan reverse-rename-sid-stability-20260520 §A.4-pre S1 R6 HIGH-R6-1 + R7 HIGH-R7-1**:
   * bridge 内部 internal 字段(**REVIEW_105 MED-1: 本字段 SSOT 锚点 — facade ClaudeCreateOpts /
   * CreateSessionOptionsRaw 不再声明本字段, 见 adapters/types/create-session-opts.ts REVIEW_105 注释**):
   * - caller 不该传(默认走反查 sessionRepo.cliSessionId 兜底回填)
   * - recoverer.ts:486 + restart-controller.ts:185/339 caller 显式传 `rec.cliSessionId ?? sessionId`
   *   让 bridge 内部 SDK options.resume + jsonl preflight + S6 fork detect compare 拿正确 cli sid。
   *
   * **null 边角**: caller 不传 → bridge 内部三分支 resolve(R7 HIGH-R7-1 修订, create-session-sdk-query.ts):
   *   `opts.resumeMode === 'fresh-cli-reuse-app' ? undefined : !opts.resume ? undefined :`
   *   `(opts.resumeCliSid ?? sessionRepo.get(opts.resume)?.cliSessionId ?? opts.resume)`
   */
  resumeCliSid?: string;
  /**
   * **plan reverse-rename-sid-stability-20260520 §A.4-pre S1 R3 HIGH-G + R7 HIGH-R7-1**:
   * 解决 `resumeCliSid: undefined` 双语义冲突 — spawn 主路径(无 opts.resume)与 jsonl-missing
   * fallback(有 opts.resume + resumeCliSid undefined)在入参侧无法区分, 改用显式 mode 字段。
   * (**REVIEW_105 MED-1: 本字段 7 组合不变量表 SSOT 锚点, facade type 不再声明**)
   *
   * - **'resume-cli'** (default): 默认 SDK resume 行为 — caller 显式传 resumeCliSid 用之, 否则
   *   bridge 内部按 `sessionRepo.get(opts.resume)?.cliSessionId ?? opts.resume` 反查; spawn 主路径
   *   (opts.resume undefined)直接走新建路径(三分支 `!opts.resume → undefined`)
   * - **'fresh-cli-reuse-app'**: jsonl-missing fallback 专用 — 复用 caller 传入 opts.resume 作
   *   applicationSid, 但 SDK 不带 resume 起 fresh CLI thread; first realId 后只调
   *   sessionManager.updateCliSessionId 写 cli_session_id 列(不 emit session-start 不创建 NEW row)
   *
   * **R4 MED-R4-1 7 种合法/非法组合不变量表**:
   * | opts.resume | resumeMode | resumeCliSid | 路径 | effectiveResumeCliSid | SDK resume 入参 |
   * |---|---|---|---|---|---|
   * | undefined | 'resume-cli'(default) | undefined | spawn 主路径 | undefined | 不传 |
   * | 非空 | 'resume-cli' | 非空 | normal resume(显式 cli sid) | resumeCliSid | resumeCliSid |
   * | 非空 | 'resume-cli' | undefined | normal resume(反查 fallback) | sessionRepo.get(resume)?.cliSessionId ?? resume | effectiveResumeCliSid |
   * | 非空 | 'fresh-cli-reuse-app' | undefined | jsonl-missing fallback | undefined | 不传 |
   * | undefined | 'fresh-cli-reuse-app' | * | **错误 — runtime guard reject** | - | - |
   * | 非空 | 'fresh-cli-reuse-app' | 非空 | **错误 — runtime guard reject** | - | - |
   * | undefined | 'resume-cli' | 非空 | **错误 — runtime guard reject** | - | - |
   *
   * **R4 MED-R4-1 runtime guard**: bridge createThunk / createSession 入口加 `assertCreateOptsValid(opts)`,
   * 3 种非法组合直接抛错(防 caller 误传静默走错路径)。**R8 LOW-R8-1**: `assertCreateOptsValid`
   * 必须先于 effective resolver 计算(fail-fast)。
   */
  resumeMode?: 'resume-cli' | 'fresh-cli-reuse-app';
  /**
   * plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.2 internal plumbing:
   * hand_off_session handler 装配后透传给 finalize 链 emit first user message 时 spread 进
   * events.payload(详 session-finalize.ts FinalizeSessionStartArgs.handOff jsdoc)。
   * caller 不该传(typical caller 走 spawn handler / hand_off handler 注入)。
   */
  handOff?: HandOffMetadata;
  /**
   * REVIEW_58 HIGH ✅ (deep-review 双方共识真问题修法):跳过 finalizeSessionStart 内 emit
   * 首条 user message。详 recoverer.ts CreateSessionThunk.skipFirstUserEmit jsdoc。
   *
   * **触发场景**:recoverer.recoverAndSend 调本路径时显式传 true(emit 责任已在
   * recoverAndSend 入口收口与 live 主路径 sendMessage `if (s)` 路径对称,避免双气泡)。
   *
   * **caller 不该传**(默认 false / undefined):spawn 主路径 / IPC AdapterCreateSession
   * 走此路径,首条 prompt 没经过 sendMessage emit user message,必须由 finalize 补 emit
   * 让 UI 活动流看到「你」发的第一条话。
   */
  skipFirstUserEmit?: boolean;
  /**
   * Programmatic creates need the final SDK id. UI creates omit this so the bridge can return a
   * visible temporary app id immediately and rename it after the first SDK frame.
   */
  awaitCanonicalId?: boolean;
  /**
   * **REVIEW_99 R3 cancellation-epoch MED 修法 (post-guard 窗口)**:recover 路径传 cancelGuard
   * thunk,createSession 内部在 pre-registration await(loadSdk / buildMcpServersForSession)之后、
   * sessions.set / query 启动**之前**调一次 — 返 true(用户 await 期间再次 close → close-epoch 变
   * /record 被删)→ throw RecoveryCancelledError(sentinel)abort,不起 fresh CLI / 不污染 sessions Map。
   *
   * **caller 不该传**(默认 undefined → 不 gate):spawn 主路径 / IPC AdapterCreateSession / restart
   * 路径都不传(restart 本就先 close 再 cold restart,过渡态 close 是预期不能拦)。仅 recover 两端
   * (recover-and-send-impl normal-resume createThunk + jsonl-fallback helper 内 createSession)传。
   *
   * sentinel 由 recoverer outer catch / inflight waiter special-case 识别后静默 abort
   * (不 emit「自动恢复失败」)。详 @main/adapters/shared/recovery-cancelled.ts。
   */
  cancelCheck?: () => boolean;
}

/**
 * sdk-query / impl orchestrator 子模块注入的 facade ref bundle。
 *
 * **抽出动机**：facade.createSession 巨型 method 持有 facade ref（this.sessions Map /
 * this.opts.emit / this.streamProcessor / this.responder 等）。子模块化后需要通过
 * deps 注入让子模块访问这些 ref（避免子模块 import facade class 撞循环 import）。
 *
 * **字段语义**：
 * - `sessions` — facade.sessions Map（SHARED, mutate sessions.set / delete）
 * - `emit` — facade.opts.emit thunk
 * - `streamProcessor` — facade.streamProcessor instance（makeUserMessage /
 *   createUserMessageStream / waitForRealSessionId）
 * - `responder` — facade.responder instance（makeCanUseTool deps）
 * - `getPermissionTimeoutMs` — facade.permissionTimeoutMs getter（makeCanUseTool deps）
 * - `interrupt` — facade.interrupt thunk（return handle.abort delegate）
 */
export interface CreateSessionDeps {
  readonly sessions: Map<string, InternalSession>;
  readonly emit: SdkBridgeOptions['emit'];
  readonly streamProcessor: StreamProcessor;
  readonly responder: PermissionResponder;
  readonly getPermissionTimeoutMs: () => number;
  readonly interrupt: (sessionId: string) => Promise<void>;
}

/**
 * prepare phase 派生 state — orchestrator validate → prepare → sdk-query 间传递。
 *
 * **抽出动机**：原 inline createSession L264-307 prepare 段（tempKey allocate +
 * releasePending + claimAsSdk + makeInternalSession + pendingUserMessages push +
 * userMessageIterable + canUseTool 装配）派生 ~7 个跨段共享 ref。orchestrator 把
 * 这些 ref 通过本 interface 一次性返回给 sdk-query phase。
 */
export interface PreparedSessionContext {
  readonly tempKey: string;
  readonly releasePending: () => void;
  readonly internal: InternalSession;
  readonly userMessageIterable: AsyncIterable<SDKUserMessage>;
  readonly canUseTool: ReturnType<typeof import('../can-use-tool').makeCanUseTool>;
  readonly claudeSandboxMode: 'off' | 'workspace-write' | 'strict';
  readonly claudeModel: string | undefined;
  readonly initialSessionEmitted?: boolean;
}

/**
 * sdk-query phase 派生 state — sdk-query → finalize 间传递。
 *
 * **抽出动机**：原 inline createSession L344-450 sdk-query 段成功路径返回 `realId`
 * 让 finalize 链用。失败路径 throw 让 orchestrator 上层 catch（catch cleanup 由
 * sdk-query 内部就近做，throw 时已 cleanup 完）。
 */
export interface SdkQueryResult {
  readonly realId: string;
}

/**
 * createSession 完成时返回的 SdkSessionHandle 也通过 SSOT re-export 让子模块少 import 路径。
 */
export type { SdkSessionHandle };

/**
 * canUseTool query options 用的 Query 类型 re-export — 子模块 internal.query 赋值需要。
 */
export type { Query };
