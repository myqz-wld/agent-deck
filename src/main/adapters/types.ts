import type {
  AgentEvent,
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  PermissionRequest,
  PermissionResponse,
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
  model?: string;
  permissionMode?: PermissionMode;
  /** 传旧 sessionId 表示恢复历史会话。仅 SDK 通道有意义（hook 通道无状态）。 */
  resume?: string;
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
   * 删会话时 SessionManager 是否调 closeSession 彻底关闭 SDK 侧 live query/turn 与 pending Maps。
   * 与 canInterrupt 区别：interrupt 允许 resume / 复用 session；close 表示永久关闭。
   * 占位 adapter（aider / generic-pty）置 false；hook-only / SDK 通道有 internal session 的 adapter 置 true。
   */
  canCloseSession: boolean;
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
  sendMessage?(sessionId: string, text: string): Promise<void>;
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
}
