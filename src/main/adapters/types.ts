import type {
  AgentEvent,
  AgentDeckTeammateEvent,
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  GenericPtyConfig,
  PermissionRequest,
  PermissionResponse,
  UploadedAttachmentRef,
} from '@shared/types';
import type { HookServer } from '@main/hook-server/server';
import type { RouteRegistry } from '@main/hook-server/route-registry';

export interface AdapterContext {
  hookServer: HookServer;
  routeRegistry: RouteRegistry;
  emit: (event: AgentEvent) => void;
  paths: {
    userHome: string;
    userClaudeSettings: string;
  };
}

/**
 * 所有 4 adapter 共享的最小字段集（cwd / prompt）。各 adapter 专属 interface 内联其余
 * 字段保 jsdoc 集中（不抽 BaseCreateOpts，让每个 interface 自身可读完整字段集）。
 */

/**
 * 共享 PTY 子集（aider / generic-pty 共用）。
 *
 * PTY adapter 只消费 cwd / prompt / genericPtyConfig；teamName 透传不消费（universal team
 * backend 走 sessionManager 路径，不在 adapter.createSession 内处理）；attachments 字段保留
 * 兼容 caller 透传，adapter 静默丢图（capabilities.canAcceptAttachments=false 上层 UI 已 gate
 * 入口，REVIEW_35 HIGH-D2）。
 *
 * **不**含 resume（PTY 不支持恢复 — 每次新起 PTY 子进程）/ permissionMode（无概念）/
 * model（无概念）/ codexSandbox / claudeCodeSandbox / extraAllowWrite。
 */
export interface PtyCreateOpts {
  cwd: string;
  prompt?: string;
  /**
   * R3 universal team backend：spawn_session 入口可附 team_name，由 MCP / IPC handler 在调用前
   * ensure-team-by-name + addMember；adapter 自己**不**处理 team。字段透传不消费保 caller spread
   * 兼容（spawn caller 不挑 adapter 透 teamName）。
   */
  teamName?: string;
  /**
   * 字段兼容 caller 透传（attachments 在 caller / IPC 端不挑 adapter spread）；PTY adapter 静默
   * 丢图（capabilities.canAcceptAttachments=false 上层 UI 已 gate 入口）。
   */
  attachments?: UploadedAttachmentRef[];
  /**
   * R4·F2：generic-pty / aider session 的 spawn config 透传。zod 校验由 IPC 入口统一前置
   * （adapters.ts createAdapterSession handler）。
   *
   * - undefined：generic-pty / aider adapter 自行 fallback 到内置 preset config
   *   （aider 的 fallback = 'aider' preset；generic-pty 的 fallback = createSession throw "missing config"）
   * - GenericPtyConfig：用户在 NewSessionDialog 自定义 / 选 preset 后微调
   *
   * adapter 内部把入参 config 写入 sessions.generic_pty_config 持久化，resume 时读回。
   */
  genericPtyConfig?: GenericPtyConfig;
}

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
   * 来源链：spawn handler 解 agent body frontmatter `model` 字段（reviewer-claude.md 的
   * `model: opus`）→ 传给 createSession。
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
   * SDK / agent model 透传（plan model-wiring-and-handoff-20260514 Step 2.5）。
   *
   * adapter 行为：仅 setModel 持久化（让 UI 看到 frontmatter 设的 model），runtime 仍由
   * ~/.codex/config.toml 顶层 `model` 决定（codex SDK startThread 不接受 per-thread model
   * override，详 plan D5 与 bridge createSession 注释）。
   */
  model?: string;
  /**
   * Codex per-session sandbox 档位覆盖。三档直接复用 codex SDK 原生 SandboxMode 字面量。
   * undefined = 用 settings.codexSandbox 全局值。spawn-time 一次性透传给 codex.startThread；
   * 已在跑的 thread 不受影响（运行时切档走 restartWithCodexSandbox 冷切）。
   */
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
  /**
   * 字段持久化保 parity 对称（与 ClaudeCreateOpts.extraAllowWrite 字面镜像）。
   * **codex SDK runtime 不消费**（SDK 不支持 extra writable roots, sandboxMode 三档无 allowWrite
   * 字段）；bridge 内 setExtraAllowWrite 写库保跨 adapter parity 对称（与 model 字段同款语义 —
   * runtime 不生效 / DB 写库保 SessionRecord 形态一致）。future codex SDK 加支持时零迁移成本。
   *
   * 详细持久化路径见 ClaudeCreateOpts.extraAllowWrite jsdoc。
   */
  extraAllowWrite?: readonly string[];
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
  | ({ agentId: 'aider' } & PtyCreateOpts)
  | ({ agentId: 'generic-pty' } & PtyCreateOpts);

/**
 * caller 端通用「全字段 raw」入参（buildCreateSessionOptions 的 raw 参数类型）。
 * 含所有 adapter 字段并集 + 都为 optional（caller 不挑 adapter 透传）；builder 内 switch
 * 按 agentId 把字段 narrow 到对应 union arm（filter 掉不属于该 adapter 的字段）。
 */
export interface CreateSessionOptionsRaw {
  cwd: string;
  prompt?: string;
  permissionMode?: PermissionMode;
  resume?: string;
  teamName?: string;
  attachments?: UploadedAttachmentRef[];
  model?: string;
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict';
  extraAllowWrite?: readonly string[];
  genericPtyConfig?: GenericPtyConfig;
}

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export interface AdapterCapabilities {
  canCreateSession: boolean;
  canInterrupt: boolean;
  canSendMessage: boolean;
  canInstallHooks: boolean;
  canRespondPermission: boolean;
  canSetPermissionMode: boolean;
  /**
   * 是否支持「冷切」权限模式：销毁旧子进程 + 用新 mode 重建。bypassPermissions 必须冷切，
   * 因为 SDK 的 `allowDangerouslySkipPermissions` flag 在子进程启动时锁死，运行时
   * setPermissionMode('bypassPermissions') 会被 SDK 静默吞。
   * 仅 Claude Code SDK 通道支持；codex-cli / hook-only adapter 置 false。
   */
  canRestartWithPermissionMode: boolean;
  /**
   * 是否支持「冷切」codex sandbox 档位（CHANGELOG_<X> A2b）：销毁旧 codex thread + 用新
   * sandboxMode resume 重建。codex SDK 的 sandboxMode 是 startThread/resumeThread 一次性
   * 参数，运行时无法热切，必须冷切。仅 codex-cli adapter 置 true；其他 adapter 置 false。
   *
   * 与 canRestartWithPermissionMode 正交：codex 没有 PermissionMode 概念，
   * 这是 codex 专属的 capability。
   */
  canRestartWithCodexSandbox: boolean;
  /**
   * 是否支持「冷切」claude OS sandbox 档位（CHANGELOG_74）：销毁旧 SDK 子进程 + 用新档位
   * createSession resume 重建。SDK 的 sandbox options 是 query() spawn-time 锁定，无法热切。
   * 与 canRestartWithCodexSandbox 字面镜像。仅 claude-code adapter 置 true；其他 adapter 置 false。
   */
  canRestartWithClaudeCodeSandbox: boolean;
  /**
   * 删会话时 SessionManager 是否调 closeSession 彻底关闭 SDK 侧 live query/turn 与 pending Maps。
   * 与 canInterrupt 区别：interrupt 允许 resume / 复用 session；close 表示永久关闭。
   * SDK / PTY 通道有 internal session 的 adapter 都置 true（claude-code / codex-cli /
   * aider / generic-pty）；纯 hook-only adapter 置 false。
   */
  canCloseSession: boolean;
  /**
   * 是否支持作为 team member 接收 cross-adapter 消息（R3.E0 ADR §3.1 / E4 新增）。
   * - claude-code / codex-cli: true（SDK sendMessage 把外来文字塞进 user turn）
   * - aider / generic-pty: true（R4·F-bonus 实装：PTY bridge sendMessage 把外来文字
   *   写入 stdin，与 user 输入等价）
   *
   * UI 据此与 archived/closed 双条件决定 NewTeamMember dialog 是否暴露该 adapter。
   * 取代老 capability `canJoinTeam`（R3.E6 已删，仅 Claude experimental teams flag 触发器）。
   */
  canCollaborate: boolean;
  /**
   * REVIEW_35 HIGH-D2：是否支持图片附件（用户在 Composer 上传 / 粘 / 拖图）。
   * - claude-code / codex-cli: true（SDK content blocks 接收 image base64）
   * - aider / generic-pty: false（PTY 写 stdin 没法编码二进制 → 静默丢图）
   *
   * UI 据此 gate Composer 的图片入口（隐藏上传按钮 + 不绑 onPaste/onDrop/onDragOver）+
   * send 入口拦截 attachments-only 请求（避免 imgs.clear 后用户失去 retry 能力）。
   */
  canAcceptAttachments: boolean;
}

export interface AgentAdapter {
  id: string;
  displayName: string;
  capabilities: AdapterCapabilities;

  init(ctx: AdapterContext): Promise<void>;
  shutdown(): Promise<void>;

  createSession?(opts: CreateSessionOptions): Promise<string>;
  interruptSession?(sessionId: string): Promise<void>;
  /**
   * 由 SessionManager.delete 调用：abort SDK 侧 live query/turn + 清 pending Maps + 移除 internal session 记录。
   * 纯 hook-only adapter 不实现；SDK / PTY 通道 adapter（claude-code / codex-cli / aider /
   * generic-pty）均实现。
   * 不抛错（出错只 warn）：删除路径不能因为 close 失败而失败，否则 DB 行删了 bridge 状态留着会更糟。
   */
  closeSession?(sessionId: string): Promise<void>;
  sendMessage?(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
  ): Promise<void>;
  respondPermission?(
    sessionId: string,
    requestId: string,
    response: PermissionResponse,
  ): Promise<void>;
  respondAskUserQuestion?(
    sessionId: string,
    requestId: string,
    answer: AskUserQuestionAnswer,
  ): Promise<void>;
  respondExitPlanMode?(
    sessionId: string,
    requestId: string,
    response: ExitPlanModeResponse,
  ): Promise<void>;
  setPermissionMode?(sessionId: string, mode: PermissionMode): Promise<void>;
  /**
   * 冷切：销毁旧 SDK 子进程 + 用新 mode 重建。`handoffPrompt` 必须非空（SDK streaming
   * 协议约束），调用方负责拼好语义。仅 bypassPermissions 必须走此路径，其他档可热切。
   * 失败时内部已 emit error message + 回滚 DB 到旧 mode，throw 仅用于上层 log。
   */
  restartWithPermissionMode?(
    sessionId: string,
    mode: PermissionMode,
    handoffPrompt: string,
  ): Promise<string>;

  /**
   * Codex 专属冷切（CHANGELOG_<X> A2b）：销毁旧 codex thread 子进程 + 用新 sandbox
   * 档位 resume 重建。`handoffPrompt` 必须非空（codex SDK runStreamed 协议约束，
   * resume 路径必须有 prompt 触发首条 turn）。
   *
   * 与 claude restartWithPermissionMode 同模式：
   * - 失败时内部 emit error message + 回滚 sessionRepo.codexSandbox 到旧档
   * - 返回 sessionId 用于追踪（codex resume 不会隐式 fork，理论上等于入参 sid，
   *   但接口签名与 claude 对齐保留 string 返回）
   *
   * capabilities.canRestartWithCodexSandbox: true 时调用方才能调此方法；其他 adapter
   * 字段无意义不实现。
   */
  restartWithCodexSandbox?(
    sessionId: string,
    sandbox: 'workspace-write' | 'read-only' | 'danger-full-access',
    handoffPrompt: string,
  ): Promise<string>;

  /**
   * Claude Code OS 沙盒冷切（CHANGELOG_74）：销毁旧 SDK 子进程 + 用新档位 createSession
   * resume 重建。`handoffPrompt` 必须非空（SDK streaming 协议约束）。
   * 与 restartWithCodexSandbox 字面镜像。失败回滚 sessionRepo.claudeCodeSandbox。
   * capabilities.canRestartWithClaudeCodeSandbox: true 时调用方才能调此方法。
   */
  restartWithClaudeCodeSandbox?(
    sessionId: string,
    sandbox: 'off' | 'workspace-write' | 'strict',
    handoffPrompt: string,
  ): Promise<string>;

  /** 重启 / HMR 后 renderer store 会丢 pending 列表；这里给一次快照重建 UI。 */
  listPending?(sessionId: string): {
    permissions: PermissionRequest[];
    askQuestions: AskUserQuestionRequest[];
    exitPlanModes: ExitPlanModeRequest[];
  };
  listAllPending?(): Record<string, {
    permissions: PermissionRequest[];
    askQuestions: AskUserQuestionRequest[];
    exitPlanModes: ExitPlanModeRequest[];
  }>;
  /** 运行时调权限超时阈值（settings 改动 → bridge 即改即生效）。 */
  setPermissionTimeoutMs?(ms: number): void;
  /** Codex 专属：设置面板「Codex 二进制路径」变更时即改即生效。 */
  setCodexCliPath?(path: string | null): void;

  installIntegration?(opts: {
    scope: 'user' | 'project';
    cwd?: string;
  }): Promise<unknown>;
  uninstallIntegration?(opts: {
    scope: 'user' | 'project';
    cwd?: string;
  }): Promise<unknown>;
  integrationStatus?(opts: {
    scope: 'user' | 'project';
    cwd?: string;
  }): Promise<unknown>;

  /**
   * R3.E0 ADR §3.1 / E4 新增：把另一个 team member（来自任意 adapter）发来的消息塞进
   * 本 session 的 user turn。
   *
   * 实现约束：
   * - 必须**至少一次** delivery（重试 ≥ 1 次后才认为 failed）。watcher 先 update
   *   status='delivering' 再调；adapter 抛错 → watcher catch + 退避（详 ADR §4.5）。
   * - **不要**自己拼 fromMember 元信息前缀。watcher 已在 body 里拼好（统一格式见 ADR §4.4
   *   `[from <displayName> @ <adapterId>][msg <id>]\n<原始 body>`，Phase B7 加 messageId 让
   *   teammate 能 reply_message）。adapter 直接 sendMessage(sessionId, body)。
   *   fromMemberId 仅用于 logging / 路由调试。
   * - 必须是异步：返回 Promise；resolve 表示「已成功提交给 adapter 的 message queue」（不是
   *   「session 已生成 reply」）。watcher 不等 reply。
   *
   * capability 检查：调用方必须先看 capabilities.canCollaborate；为 true 的 adapter 应实现此方法。
   * E5 watcher 在调前会 double-check：未实现 → status='failed' reason='adapter-no-collaborate'。
   */
  receiveTeammateMessage?(
    sessionId: string,
    fromMemberId: string,
    body: string,
  ): Promise<void>;

  /**
   * R3.E0 ADR §3.1 / §4.9 dispatcher：通知本 session 同 team 有 teammate 元事件
   * （teammate 加入 / 离开 / team 归档）。
   *
   * 设计为 **optional + best-effort**：adapter 可不实现（默认丢弃事件）。
   * 实现的 adapter 把事件以 system message / banner 形式插入 session
   * （如「[team] codex-helper joined」）。
   * dispatcher 不等返回，也不重试 —— 这只是观察性事件，不是关键路径。
   */
  notifyTeammateEvent?(
    sessionId: string,
    event: AgentDeckTeammateEvent,
  ): Promise<void>;

  /**
   * R37 P2-I Step 3.3：LLM 驱动的「会话最近做什么」生成入口（dispatch 下放）。
   *
   * 之前 caller (summarizer/index.ts + ipc/sessions.ts hand-off path) 自己 `if
   * (session.agentId === 'claude-code') ... else if ('codex-cli')` 派发到不同 runner，
   * adapter 概念被 caller 端 leak。下放到 adapter 后 caller 只调
   * `adapter.summariseEvents?.(cwd, events, kind)`，未实装则拿 undefined 自然走 fallback
   * （summarizer 路径走 assistant message / 兜底统计；ipc/sessions hand-off 路径走
   * claude path 兜底，详 caller 端注释）。
   *
   * @param kind 区分两种 prompt 模板 + timeout：
   *   - 'summary'：周期 30 字短摘要（claude haiku ~6s / codex 'low' effort，timeout 走
   *     settings.summaryTimeoutMs）
   *   - 'handoff'：4 节结构化简报（claude sonnet / codex 'medium' effort，60s timeout
   *     hardcoded）
   *
   * @returns LLM 生成的文本；events 为空 / LLM 返回空串 → null；timeout / 进程错 → throw
   *   （caller 走 catch 兜底）。
   *
   * 行为契约：
   * - 不抛 fallback：runner 失败必须 throw（caller 决定要不要降级），不要内部 swallow
   * - kind 必须 narrow 到 'summary' | 'handoff' 两值之一（unknown kind → throw）
   * - aider / generic-pty 不实装：没 SDK oneshot 通道，caller 拿 undefined 走 fallback
   */
  summariseEvents?(
    cwd: string,
    events: AgentEvent[],
    kind: 'summary' | 'handoff',
  ): Promise<string | null>;
}
