import type {
  AgentEvent,
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
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
   * Agent Teams 团队名（仅 SDK 通道支持）。语义：应用内标签 + env 触发条件——
   * 当 settingsStore.agentTeamsEnabled === true 且 teamName?.trim() 非空时，
   * sdk-bridge 在 spawn CLI 子进程时把 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
   * 注入到 query() 的 env，让 Claude 内部启用 agent teams 实验特性。
   *
   * teamName 不会作为 SDK options 直接传给 Claude（Claude 自身用自然语言驱动建队 +
   * 在 ~/.claude/teams/<name>/config.json 自管命名）；用户须在首条 prompt 里告诉 Claude
   * 用这个名字（NewSessionDialog 给提示模板）。
   *
   * resume 路径下传 teamName 视为非法（Agent Teams 不支持 session resumption），
   * sdk-bridge 直接 throw。
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
   * 删会话时 SessionManager 是否调 closeSession 彻底关闭 SDK 侧 live query/turn 与 pending Maps。
   * 与 canInterrupt 区别：interrupt 允许 resume / 复用 session；close 表示永久关闭。
   * 占位 adapter（aider / generic-pty）置 false；hook-only / SDK 通道有 internal session 的 adapter 置 true。
   */
  canCloseSession: boolean;
  /**
   * 是否支持加入 Claude Code agent teams（实验特性，需 CLI ≥ v2.1.32）。
   * - claude-code: true（SDK env 注入即启用）
   * - codex-cli / aider / generic-pty: false（不走 Claude Code CLI）
   * UI 据此与 settings.agentTeamsEnabled 双条件决定 NewSessionDialog 是否暴露 teamName 输入框。
   */
  canJoinTeam: boolean;
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
}
