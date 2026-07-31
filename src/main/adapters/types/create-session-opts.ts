// ────────────────────────────────────────────────────────────────────────────
// Phase 4 Step 4.9 拆分:adapter.createSession 入参 declaration(纯 type)。
// 收纳:ClaudeCreateOpts / CodexCreateOpts / CreateSessionOptions / CreateSessionOptionsRaw。
// ────────────────────────────────────────────────────────────────────────────

import type {
  AdapterSessionMode,
  HandOffMetadata,
  UploadedAttachmentRef,
} from '@shared/types';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import type {
  ClaudeThinkingLevel,
  CodexThinkingLevel,
  GrokThinkingLevel,
} from '@shared/session-metadata';

import type { PermissionMode } from './adapter-context';

export type ClaudeCodeEffortLevel = ClaudeThinkingLevel;
export type CodexModelReasoningEffort = CodexThinkingLevel;
export type GrokReasoningEffort = GrokThinkingLevel;

/** Main-only registration metadata used to materialize an MCP spawn edge on the first SDK row. */
export interface InitialSessionRegistration {
  spawnLink: {
    parentSessionId: string;
    depth: number;
  };
  /** Internal sessions stay live-addressable but are omitted from user-facing History. */
  hiddenFromHistory?: boolean;
  /** Called synchronously after the linked session-start has been durably ingested. */
  onRegistered: (applicationSessionId: string) => void;
}

/**
 * 所有 2 adapter 共享的最小字段集（cwd / prompt）。各 adapter 专属 interface 内联其余
 * 字段保 jsdoc 集中（不抽 BaseCreateOpts，让每个 interface 自身可读完整字段集）。
 */

/**
 * Claude Code adapter 专属 createSession opts。与 CodexCreateOpts 字段不同处:
 * 含 Claude SDK permissionMode（公开五档及 provider-only 恢复态 dontAsk）+
 * claudeCodeSandbox（OS 沙盒档位）+ 不含 codexSandbox。
 */
export interface ClaudeCreateOpts {
  cwd: string;
  prompt?: string;
  /** Claude Gateway profile id. The adapter resolves it to one session-local settings file. */
  gateway?: string;
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
  /** Explicit native Plugin root for a selected Claude Plugin Agent. */
  claudePluginDir?: string;
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
   * 真正生效）。Codex 端同一 provider-neutral 字段映射到 app-server writableRoots。
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
 * 不含 Claude permissionMode（Codex 使用 app-server approvalPolicy + server requests）
 * + 含 codexSandbox（Codex 三档 sandboxMode）+ 不含 claudeCodeSandbox。
 */
export interface CodexCreateOpts {
  cwd: string;
  prompt?: string;
  /** Native Codex config profile id applied when starting the session app-server process. */
  profile?: string;
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
   * complexity (`low` through `ultra`). Undefined lets a new session resolve the valid
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
   * Provider-neutral sandbox writable roots. The bridge merges this list into Codex app-server
   * workspace-write `writableRoots` and persists it for resume/recovery.
   */
  extraAllowWrite?: readonly string[];
  // **REVIEW_105 MED-1 (deep-review Batch 7)**: resumeCliSid / resumeMode 同 ClaudeCreateOpts —
  // bridge 内部 internal 字段(caller 不该传, 仅 codex recoverer / restart-controller 直调 bridge
  // 时显式传), 按既定分层只活在 bridge 内部 CreateSessionOpts(codex create-session/_deps.ts),
  // **不进 facade CodexCreateOpts**。修前误混进 facade type 但 narrowToCodexOpts / facade.createSession
  // 白名单都不传(死字段)。详 ClaudeCreateOpts extraAllowWrite 下方 REVIEW_105 注释。
  /**
   * plan codex-handoff-team-alignment-20260518 §P3 Step 3.5 + §不变量 6 (v4 修订) + §D7：
   * codex app-server `approvalPolicy` 透传。当前 provider 支持 `untrusted`、`on-request`
   * 和 `never`。caller 显式值和同 adapter 继承值优先；否则 Codex target 默认
   * `on-request`。Reviewer Agent 名称不会隐式改变该策略。
   *
   * app-server 在每次 turn/start 读取该值，因此会话页可持久化并热更新下一轮策略。
   */
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  /**
   * plan §P3 Step 3.5 + §不变量 6：codex SDK startThread `networkAccessEnabled` 透传。
   * 该字段只由可信 lifecycle caller 显式设置或从同 adapter source 继承；`agentName`
   * 不会注入默认值。它与 `webSearchEnabled` 解耦。
   *
   * undefined → 沿用 Codex config / runtime 默认。
   */
  networkAccessEnabled?: boolean;
  /**
   * plan §P3 Step 3.5 + §不变量 6：codex SDK startThread `additionalDirectories` 透传，
   * 让 codex sandbox=workspace-write 档位下额外允许的可读写根。
   * 该字段只由可信 lifecycle caller 显式设置或从同 adapter source 继承；`agentName`
   * 不会注入默认路径。
   *
   * undefined → 沿用 codex SDK 默认（不加额外路径）。
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

/** Grok Build ACP session options. Grok owns authentication, native tools, and session history. */
export interface GrokCreateOpts {
  cwd: string;
  prompt?: string;
  resume?: string;
  teamName?: string;
  attachments?: UploadedAttachmentRef[];
  model?: string;
  reasoningEffort?: GrokReasoningEffort;
  sessionMode?: AdapterSessionMode;
  /** Native Grok sandbox profile. Undefined delegates to the configured Grok default. */
  grokSandbox?: string | null;
  /** Validated Grok native agent selected by spawn_session(agentName). */
  grokAgentName?: string;
  /** Source used to decide whether Agent Deck's bundled agent plugin must be injected. */
  grokAgentSource?: 'bundled' | 'project' | 'user' | 'plugin';
  /** Explicit native plugin root for a selected Grok plugin Agent, when needed. */
  grokPluginDir?: string;
  handOff?: HandOffMetadata;
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
  | ({ agentId: 'codex-cli' } & CodexCreateOpts)
  | ({ agentId: 'grok-build' } & GrokCreateOpts);

/**
 * caller 端通用「全字段 raw」入参（buildCreateSessionOptions 的 raw 参数类型）。
 * 含所有 adapter 字段并集 + 都为 optional（caller 不挑 adapter 透传）；builder 内 switch
 * 按 agentId 把字段 narrow 到对应 union arm（filter 掉不属于该 adapter 的字段）。
 *
 * Runtime policy fields are adapter-owned and explicit. `agentName` is resolved before this
 * builder and never changes permission or sandbox fields implicitly.
 */
export interface CreateSessionOptionsRaw {
  cwd: string;
  prompt?: string;
  /** Claude Gateway profile id; only the Claude adapter consumes this field. */
  gateway?: string;
  /** Native Codex config profile id; only the Codex adapter consumes this field. */
  profile?: string;
  permissionMode?: PermissionMode;
  resume?: string;
  teamName?: string;
  attachments?: UploadedAttachmentRef[];
  model?: string;
  claudeCodeEffortLevel?: ClaudeCodeEffortLevel;
  modelReasoningEffort?: CodexModelReasoningEffort;
  reasoningEffort?: GrokReasoningEffort;
  sessionMode?: AdapterSessionMode;
  grokAgentName?: string;
  grokAgentSource?: 'bundled' | 'project' | 'user' | 'plugin';
  grokPluginDir?: string;
  developerInstructions?: string;
  codexConfigOverrides?: CodexConfigObject;
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict';
  grokSandbox?: string | null;
  claudeAgentName?: string;
  claudeAgents?: Record<string, AgentDefinition>;
  claudePluginDir?: string;
  extraAllowWrite?: readonly string[];
  // **REVIEW_105 MED-1 (deep-review Batch 7)**: 移除 resumeCliSid / resumeMode —— 修前 Raw 声明
  // 这两字段 + jsdoc 写「builder narrow 时透传给 claude / codex 都消费」, 但 narrowToClaudeOpts /
  // narrowToCodexOpts 都不挑、facade.createSession 白名单也不 spread = 契约 vs 实现矛盾(死字段)。
  // 它们是 bridge 内部 internal 字段(caller 不该传, recoverer / restart 直调 bridge `ctx.createSession`
  // 时显式传), 按 cancelCheck / skipFirstUserEmit 同款分层只活在 bridge CreateSessionOpts。Raw 是
  // 「caller 经 builder 透传的字段并集」, internal 字段本不该在此声明。SSOT 不变量表见 bridge
  // create-session/_deps.ts。field 级守门 _assertNarrowCoversArmFields 防此类漏挑复发(见 options-builder.ts)。
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
