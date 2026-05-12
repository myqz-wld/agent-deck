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

export interface CreateSessionOptions {
  cwd: string;
  prompt?: string;
  permissionMode?: PermissionMode;
  /** 传旧 sessionId 表示恢复历史会话。仅 SDK 通道有意义（hook 通道无状态）。 */
  resume?: string;
  /**
   * R3 universal team backend：spawn_session 入口可附 team_name，由 MCP / IPC handler
   * 在调用前 ensure-team-by-name + addMember；adapter 自己**不**处理 team。
   * 字段保留用于把「lead 在 spawn 时同时建 team + 加 teammate」语义透传到 sessionManager.recordCreatedTeamName。
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
   * Codex per-session sandbox 档位覆盖（仅 codex-cli adapter 接收并起效；其它 adapter 忽略）。
   * 三档直接复用 codex SDK 原生 SandboxMode 字面量。undefined = 用 settings.codexSandbox 全局值。
   * 与 settings 全局值的关系：spawn-time 一次性透传给 codex.startThread；已在跑的 thread 不受影响。
   */
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
  /**
   * Claude Code per-session OS 沙盒档位覆盖（CHANGELOG_74：仅 claude-code adapter 接收并起效；
   * 其它 adapter 忽略）。三档直接复用 settings.claudeCodeSandbox 字面量。
   * undefined = 用 settings.claudeCodeSandbox 全局值（resume 路径会再从 sessionRepo 兜底读回）。
   * 与 codexSandbox 完全字面对称。
   */
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict';
  /**
   * R4·F2：generic-pty / aider session 的 spawn config 透传（仅这两 adapter 接收并起效；
   * 其它 adapter 忽略）。zod 校验由 IPC 入口统一前置（adapters.ts createAdapterSession handler）。
   *
   * - undefined：generic-pty / aider adapter 自行 fallback 到内置 preset config
   *   （aider 的 fallback = 'aider' preset；generic-pty 的 fallback = createSession throw "missing config"）
   * - GenericPtyConfig：用户在 NewSessionDialog 自定义 / 选 preset 后微调
   *
   * adapter 内部把入参 config 写入 sessions.generic_pty_config 持久化，resume 时读回。
   */
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
   * 占位 adapter（aider / generic-pty）置 false；hook-only / SDK 通道有 internal session 的 adapter 置 true。
   */
  canCloseSession: boolean;
  /**
   * 是否支持作为 team member 接收 cross-adapter 消息（R3.E0 ADR §3.1 / E4 新增）。
   * - claude-code / codex-cli: true（都有 sendMessage 把外来文字塞进 user turn）
   * - aider / generic-pty: false（占位，F 阶段实装后改 true）
   *
   * UI 据此与 archived/closed 双条件决定 NewTeamMember dialog 是否暴露该 adapter。
   * 取代老 capability `canJoinTeam`（R3.E6 已删，仅 Claude experimental teams flag 触发器）。
   */
  canCollaborate: boolean;
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
   * 占位 adapter / hook-only adapter 不实现；SDK 通道 adapter（claude-code / codex-cli）实现。
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
  /** Codex 专属：设置面板「Codex 沙盒档位」变更时更新 bridge 字段；下次新建会话生效。 */
  setCodexSandboxMode?(mode: 'workspace-write' | 'read-only' | 'danger-full-access'): void;

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
}
