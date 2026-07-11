// ────────────────────────────────────────────────────────────────────────────
// Phase 4 Step 4.9 拆分:adapter.createSession 入参 declaration(纯 type)。
// 收纳:ClaudeCreateOpts / CodexCreateOpts / CreateSessionOptions / CreateSessionOptionsRaw。
// ────────────────────────────────────────────────────────────────────────────

import type {
  HandOffMetadata,
  UploadedAttachmentRef,
} from '@shared/types';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import type { ClaudeThinkingLevel, CodexThinkingLevel } from '@shared/session-metadata';

import type { PermissionMode } from './adapter-context';

export type ClaudeCodeEffortLevel = ClaudeThinkingLevel;
export type CodexModelReasoningEffort = CodexThinkingLevel;

/** Main-only registration metadata used to materialize an MCP spawn edge on the first SDK row. */
export interface InitialSessionRegistration {
  spawnLink: {
    parentSessionId: string;
    depth: number;
  };
  /** Called synchronously after the linked session-start has been durably ingested. */
  onRegistered: (applicationSessionId: string) => void;
}

/**
 * 所有 2 adapter 共享的最小字段集（cwd / prompt）。各 adapter 专属 interface 内联其余
 * 字段保 jsdoc 集中（不抽 BaseCreateOpts，让每个 interface 自身可读完整字段集）。
 */

/**
 * Claude Code adapter 专属 createSession opts。与 CodexCreateOpts 字段不同处:
 * 含 permissionMode（claude SDK 支持 default / acceptEdits / plan / bypassPermissions 四档）+
 * claudeCodeSandbox（OS 沙盒档位）+ 不含 codexSandbox。
 */
export interface ClaudeCreateOpts {
  cwd: string;
  prompt?: string;
  permissionMode?: PermissionMode;
  /** 传旧 sessionId 表示恢复历史会话。仅 SDK 通道有意义（hook 通道无状态）。 */
  resume?: string;
  /**
   * R3 universal team backend：spawn_session 入口可附 team_name，由 MCP / IPC handler 在调用前
   * ensure-team-by-name + addMember；adapter 自己**不**处理 team。字段保留用于把「lead 在 spawn
   * 时同时建 team + 加 teammate」语义透传到 sessionManager.recordCreatedTeamName。
   * 老 Claude Code experimental teams flag (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`) 已 R3.E6 删除。
   */
  teamName?: string;
  /**
   * 首条 user message 的图片附件。IPC 层 writeUploadedImage 已落盘到
   * <userData>/image-uploads/<uuid>.<ext>，这里传的是落盘后的 ref。
   * adapter 内部把 attachments 拼进首条 user message 的 content blocks。
   */
  attachments?: UploadedAttachmentRef[];
  /**
   * SDK / agent model 透传（plan model-wiring-and-handoff-20260514 Step 2.1）。
   *
   * 来源链：spawn handler 解 adapter-native agent config 的 `model` 字段 → 传给 createSession。
   *
   * adapter 行为：透传给 SDK `query({ options.model })` 真正生效；并 setModel 持久化让
   * resume / dormant 唤醒后保持一致。
   *
   * 优先级（fallback 链，由 adapter 内部实现）：opts.model → sessionRepo.get(resume)?.model
   * → undefined（让 SDK 用 ANTHROPIC_MODEL env / 自己默认）。settings.summaryModel /
   * handOffModel **不**在此路径用 — 那两字段只在 oneshot summary/hand-off 路径生效，
   * spawn / resume 路径不查 settings 全局值。
   */
  model?: string;
  /**
   * Per-session Claude Code thinking / effort level. The bridge passes this sanitized enum to SDK
   * `options.effort`. Undefined preserves the provider / user config default.
   */
  claudeCodeEffortLevel?: ClaudeCodeEffortLevel;
  /**
   * Claude Code SDK main-thread agent name. When set, `claudeAgents` should define the
   * requested agent so spawn_session(agentName) uses the SDK's native `agent` path.
   */
  claudeAgentName?: string;
  /** Programmatic Claude Code SDK agent definitions keyed by agent name. */
  claudeAgents?: Record<string, AgentDefinition>;
  /**
   * Claude Code per-session OS 沙盒档位覆盖（CHANGELOG_74）。三档直接复用
   * settings.claudeCodeSandbox 字面量。undefined = 用 settings.claudeCodeSandbox 全局值
   * （resume 路径会再从 sessionRepo 兜底读回）。与 CodexCreateOpts.codexSandbox 完全字面对称。
   */
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict';
  /**
   * REVIEW_36 R2 HIGH-B + MED-C：可选额外 writable roots（仅 workspace-write 档生效;
   * strict 档无 allowWrite,extra 也无效;'off' 档忽略）。undefined / 空数组 → 行为同原版。
   *
   * 典型场景：
   * - hand_off_session 外置 worktree（cwd=worktreePath 不在 mainRepo subtree）→ caller 传
   *   `[mainRepo]` 让外置 worktree session 能写 `mainRepo/.claude/plans/<id>.md` plan 文件
   *   （user CLAUDE.md §Step 4 plan 完成时更新 frontmatter status=completed 必须写）
   * - recoverer cwd fallback → caller 传 `[原 mainRepo]` 防 fallback 后 sandbox.allowWrite
   *   失去原 mainRepo 写权限
   *
   * **持久化（plan cross-adapter-parity-20260515 Phase A 实装,REVIEW_40 R1 reviewer-codex
   * MED-F follow-up）**: spawn 路径下由 finalizeSessionStart 写 sessions.extra_allow_write 列
   * (JSON.stringify(string[]));recoverer fallback / resume 路径从 sessionRepo.extraAllowWrite
   * 读回交还 createThunk → SDK sandbox.allowWrite。让 app 重启 / sdk-bridge state lost /
   * recoverer fallback 路径下 SDK 不丢 caller spawn 时透传的 extra writable roots。全链路实装
   * （persist + read-back + buildSandboxOptions 注入 SDK sandbox.allowWrite，workspace-write 档
   * 真正生效）。codex 端字段持久化保 parity 对称但 runtime 不消费，详 CodexCreateOpts.extraAllowWrite。
   */
  extraAllowWrite?: readonly string[];
  // **REVIEW_105 MED-1 (deep-review Batch 7, 双 reviewer + lead 三重独立命中)**:
  // resumeCliSid / resumeMode 是 bridge 内部 internal 字段(caller 不该传, 仅 recoverer /
  // restart-controller 直调 bridge `ctx.createSession` 时显式传), 语义与 cancelCheck /
  // skipFirstUserEmit 同类 → 按既定分层只活在 bridge 内部 CreateSessionOpts(claude
  // create-session/_deps.ts + codex create-session/_deps.ts), **不进 facade ClaudeCreateOpts**。
  // 修前两字段误混进 facade type 但 builder narrowToClaudeOpts / facade.createSession 白名单
  // spread 都不传它们(死字段 + Raw jsdoc「都消费」契约矛盾)。7 组合不变量表 + runtime guard
  // SSOT 已迁到 bridge create-session/_deps.ts CreateSessionOpts.resumeCliSid/resumeMode jsdoc。
  /**
   * plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.2 internal plumbing:
   * hand_off_session handler 装配后透传给 adapter,让 createSession first user message emit
   * 时 spread 进 events.payload 让 renderer 渲染 Hand-off badge + 折叠 adoptedBlock。
   * 详 HandOffMetadata jsdoc(shared/types/session.ts)+ plan §不变量 5+6。
   * caller(spawn handler / hand_off handler 之外)不该传。
   */
  handOff?: HandOffMetadata;
  /**
   * Programmatic callers such as MCP `spawn_session` need a durable handle they can use for
   * follow-up tools immediately after creation. New Claude sessions normally return a temporary
   * app id for UI latency and rename it to the real SDK session id in the background; when this is
   * true, the bridge waits for the first SDK session id and returns the canonical id.
   */
  awaitCanonicalId?: boolean;
  initialSessionRegistration?: InitialSessionRegistration;
}

/**
 * Codex CLI adapter 专属 createSession opts。与 ClaudeCreateOpts 字段不同处:
 * 不含 permissionMode（codex SDK 不支持 canUseTool 等价回调,approvalPolicy 是 startThread 字符串
 * 枚举一次性配置）+ 含 codexSandbox（codex SDK 三档 sandboxMode）+ 不含 claudeCodeSandbox。
 */
export interface CodexCreateOpts {
  cwd: string;
  prompt?: string;
  /** 传旧 sessionId 表示恢复历史会话。仅 SDK 通道有意义（hook 通道无状态）。 */
  resume?: string;
  /**
   * R3 universal team backend：spawn_session 入口可附 team_name，由 MCP / IPC handler 在调用前
   * ensure-team-by-name + addMember；adapter 自己**不**处理 team。
   */
  teamName?: string;
  /**
   * 首条 user message 的图片附件。IPC 层 writeUploadedImage 已落盘到
   * <userData>/image-uploads/<uuid>.<ext>，这里传的是落盘后的 ref。
   */
  attachments?: UploadedAttachmentRef[];
  /**
   * SDK / agent model 透传（plan model-wiring-and-handoff-20260514 Step 2.5 + prompt-asset-review-optimize-20260527 修订）。
   *
   * adapter 行为:
   * - claude-code:setModel 持久化 + bridge.createSession 透传给 SDK options.model 真切 runtime
   * - codex-cli (codex-sdk v0.131.0+):setModel 持久化 + bridge.createSession 透传给 codex SDK
   *   ThreadOptions.model 真生效;runtime 由 codex CLI 按入参 model id 跑(user 端实际可用 model
   *   由 `~/.codex/config.toml` 决定);未传值时 codex CLI fallback config.toml 顶层 model
   */
  model?: string;
  /**
   * Codex app-server ThreadOptions.modelReasoningEffort passthrough for per-session thinking
   * complexity (`minimal` through `ultra`). Undefined lets a new session resolve the valid
   * top-level Codex config value; resume keeps its persisted value instead of inheriting a changed
   * global default.
   */
  modelReasoningEffort?: CodexModelReasoningEffort;
  /**
   * Codex app-server per-session developer instructions. The bridge passes this to
   * thread/start and thread/resume `developerInstructions`; undefined preserves Codex defaults.
   */
  developerInstructions?: string;
  /** Additional Codex config layer parsed from a custom-agent TOML file. */
  codexConfigOverrides?: CodexConfigObject;
  /**
   * Codex per-session sandbox 档位覆盖。三档直接复用 Codex app-server sandbox 字面量。
   * undefined = 用 settings.codexSandbox 全局值。已在跑的 app-server thread 可通过
   * restartWithCodexSandbox 兼容入口 patch options，让下一次 turn/start 使用新档。
   */
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
  /**
   * 字段持久化保 parity 对称（与 ClaudeCreateOpts.extraAllowWrite 字面镜像）。
   * **codex SDK runtime 不消费**（SDK 不支持 extra writable roots, sandboxMode 三档无 allowWrite
   * 字段）；bridge 内 setExtraAllowWrite 写库保跨 adapter parity 对称（与 model 字段已不同款 —
   * model 字段 codex-sdk v0.131.0+ ThreadOptions.model 已支持 runtime 真生效,extraAllowWrite
   * 仍未生效,本字段仅 DB 写库保 SessionRecord 形态一致）。future codex SDK 加支持时零迁移成本。
   *
   * 详细持久化路径见 ClaudeCreateOpts.extraAllowWrite jsdoc。
   */
  extraAllowWrite?: readonly string[];
  // **REVIEW_105 MED-1 (deep-review Batch 7)**: resumeCliSid / resumeMode 同 ClaudeCreateOpts —
  // bridge 内部 internal 字段(caller 不该传, 仅 codex recoverer / restart-controller 直调 bridge
  // 时显式传), 按既定分层只活在 bridge 内部 CreateSessionOpts(codex create-session/_deps.ts),
  // **不进 facade CodexCreateOpts**。修前误混进 facade type 但 narrowToCodexOpts / facade.createSession
  // 白名单都不传(死字段)。详 ClaudeCreateOpts extraAllowWrite 下方 REVIEW_105 注释。
  /**
   * plan codex-handoff-team-alignment-20260518 §P3 Step 3.5 + §不变量 6 (v4 修订) + §D7：
   * codex SDK startThread/resumeThread `approvalPolicy` 透传（caller 显式 / options-builder
   * spread default）。codex SDK 4 档 `'never' | 'on-request' | 'on-failure' | 'untrusted'`；
   * 应用层只暴露 `'never' | 'on-request'`（teammate reviewer 默认 never 不阻断；future caller
   * 想加 on-request 走 PendingTab 兜底）。
   *
   * **enforce 点** = `options-builder.ts narrowToCodexOpts` 按 `agentName in REVIEWER_AGENT_NAMES`
   * 路径触发 default spread；**bridge 不主动 hardcode default** —— 让 caller
   * 路径 / 普通 codex session 不被污染（不变量 6）。
   *
   * spawn-time 一次性透传给 codex.startThread；undefined 时 bridge 沿用现有 default 'never'
   * （保持现状不污染普通 codex session）。运行时无热切（与 codexSandbox 同款语义）。
   */
  approvalPolicy?: 'never' | 'on-request';
  /**
   * plan §P3 Step 3.5 + §不变量 6：codex SDK startThread `networkAccessEnabled` 透传。
   * codex teammate reviewer 调外部 CLI（reviewer-claude wrapper 跑 `$AGENT_DECK_CLAUDE_PATH -p ...`）
   * 不需要 codex 本身访网；但 reviewer-codex 内可能 web search → 默认 true 让 codex SDK 内置
   * networking 走通（不被 sandbox 网络层拦），与 `webSearchEnabled` 解耦。
   *
   * undefined → 沿用 codex SDK 默认（false）。reviewer-* 路径 options-builder spread 为 true。
   */
  networkAccessEnabled?: boolean;
  /**
   * plan §P3 Step 3.5 + §不变量 6：codex SDK startThread `additionalDirectories` 透传，
   * 让 codex sandbox=workspace-write 档位下额外允许的可读写根。
   *
   * reviewer-* 路径 options-builder spread 为 `['~/.claude', '~/.codex', '/tmp']`，让 reviewer
   * 端跨目录访问 plan 文件 / claude config / codex config（review 阶段 cp 临时副本到 worktree
   * 内仍依赖这两路径作 fallback 源）；`/tmp` 是 reviewer-codex 端 shell 工具调用 / sandbox-exec
   * 中间文件路由需求（spike4 实证不含 /tmp 时 codex sandbox-exec 拒读中间文件输出）。
   *
   * undefined → 沿用 codex SDK 默认（不加额外路径）。普通 codex session 不被污染（不变量 6）。
   */
  additionalDirectories?: readonly string[];
  /**
   * plan §P3 Step 3.5 + §D1 ADR §(c) per-session env 增量字段：caller 想在 codex 子进程
   * env 注入额外变量。generic 透传机制(目前无 hot caller — reviewer-claude wrapper 路径已
   * 改 cross-adapter native 删除;字段保留供未来 caller 重用)。
   *
   * 注入路径：bridge `ensureCodex` 在 `envOverride = snapshotProcessEnv() + AGENT_DECK_MCP_TOKEN`
   * 之后 merge `opts.envOverrideExtra`（caller / options-builder spread 的字段优先级最高）。
   * 子进程拿到完整 env 集（PATH / HOME / 全局 token / per-session token / extra fields）。
   *
   * undefined / 空 object → 无新增 env 字段，behavior 与现状一致。
   */
  envOverrideExtra?: Readonly<Record<string, string>>;
  /**
   * plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.2 internal plumbing(codex 端
   * 镜像 ClaudeCreateOpts.handOff)。详 HandOffMetadata jsdoc(shared/types/session.ts) +
   * plan §不变量 5(codex 3 处 first-user-message emit:thread-loop fallback + thread-loop
   * success + sdk-bridge resume)。caller 不该传。
   */
  handOff?: HandOffMetadata;
  /**
   * Programmatic callers such as MCP `spawn_session` need a durable handle they can use for
   * follow-up tools immediately after creation. New Codex sessions normally return a temporary
   * app id for UI latency and rename it to the real thread id in the background; when this is
   * true, the bridge waits for the first `thread.started` result and returns the canonical id.
   */
  awaitCanonicalId?: boolean;
  initialSessionRegistration?: InitialSessionRegistration;
}

/**
 * adapter.createSession 入参判别联合（D2 设计）。
 *
 * caller 端用 `buildCreateSessionOptions(agentId, raw)` builder helper 在编译期 narrow 到
 * 对应 union arm，TS 阻止字段误传（如 codexSandbox 给 claude adapter / permissionMode 给 codex
 * adapter）。adapter 实现端用 `agentId` 字段 narrow 知道字段集合。
 *
 * 加新 adapter 时：(1) 加新 union arm; (2) buildCreateSessionOptions exhaustive switch 漏 arm
 * TS 编译期 `_exhaustive: never = agentId` 报错强制补 arm。
 */
export type CreateSessionOptions =
  | ({ agentId: 'claude-code' } & ClaudeCreateOpts)
  | ({ agentId: 'deepseek-claude-code' } & ClaudeCreateOpts)
  | ({ agentId: 'codex-cli' } & CodexCreateOpts);

/**
 * caller 端通用「全字段 raw」入参（buildCreateSessionOptions 的 raw 参数类型）。
 * 含所有 adapter 字段并集 + 都为 optional（caller 不挑 adapter 透传）；builder 内 switch
 * 按 agentId 把字段 narrow 到对应 union arm（filter 掉不属于该 adapter 的字段）。
 *
 * **plan codex-handoff-team-alignment-20260518 §P3 Step 3.5 + §D7（v4 信号源约定）**:
 * `agentName` 透传通道 — caller (spawn handler) 把 `args.agentName` 透到本字段；
 * `narrowToCodexOpts` 按 `agentName in REVIEWER_AGENT_NAMES` 触发 codex
 * teammate spawn default spread（不变量 6: enforce 点 = options-builder 层，**禁** bridge
 * hardcode default 污染普通 codex session）。
 *
 * `narrowToClaudeOpts` filter 掉本字段（claude adapter 没 codex teammate default 概念）。
 */
export interface CreateSessionOptionsRaw {
  cwd: string;
  prompt?: string;
  permissionMode?: PermissionMode;
  resume?: string;
  teamName?: string;
  attachments?: UploadedAttachmentRef[];
  model?: string;
  claudeCodeEffortLevel?: ClaudeCodeEffortLevel;
  modelReasoningEffort?: CodexModelReasoningEffort;
  developerInstructions?: string;
  codexConfigOverrides?: CodexConfigObject;
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict';
  claudeAgentName?: string;
  claudeAgents?: Record<string, AgentDefinition>;
  extraAllowWrite?: readonly string[];
  // **REVIEW_105 MED-1 (deep-review Batch 7)**: 移除 resumeCliSid / resumeMode —— 修前 Raw 声明
  // 这两字段 + jsdoc 写「builder narrow 时透传给 claude / codex 都消费」, 但 narrowToClaudeOpts /
  // narrowToCodexOpts 都不挑、facade.createSession 白名单也不 spread = 契约 vs 实现矛盾(死字段)。
  // 它们是 bridge 内部 internal 字段(caller 不该传, recoverer / restart 直调 bridge `ctx.createSession`
  // 时显式传), 按 cancelCheck / skipFirstUserEmit 同款分层只活在 bridge CreateSessionOpts。Raw 是
  // 「caller 经 builder 透传的字段并集」, internal 字段本不该在此声明。SSOT 不变量表见 bridge
  // create-session/_deps.ts。field 级守门 _assertNarrowCoversArmFields 防此类漏挑复发(见 options-builder.ts)。
  /**
   * plan §P3 Step 3.5 信号源（v4 D7）：spawn handler 透传 `args.agentName` 让
   * `narrowToCodexOpts` 按 reviewer-* 路径触发 codex teammate spawn default spread。
   * 仅 codex-cli adapter 消费；claude-code adapter narrow 时 filter 掉。
   */
  agentName?: string | null;
  /**
   * plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.2 internal plumbing:
   * hand_off_session handler 透传给 spawn handler args.hand_off,builder 透传给 adapter narrow。
   * 详 HandOffMetadata jsdoc(shared/types/session.ts)。caller(spawn handler / hand_off handler
   * 之外)不该传。
   */
  handOff?: HandOffMetadata;
  /**
   * Internal spawn-session plumbing for Codex programmatic creates. Not exposed as an MCP schema
   * field; handlers set it when they need a stable session id instead of the UI fast-temp id.
   */
  awaitCanonicalId?: boolean;
  /** Internal MCP spawn plumbing; absent from renderer/CLI/MCP schemas. */
  initialSessionRegistration?: InitialSessionRegistration;
}
