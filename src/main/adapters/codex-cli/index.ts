import type { AgentAdapter, AdapterContext, PermissionMode } from '../types';
import { settingsStore } from '@main/store/settings-store';
import { CodexSdkBridge } from './sdk-bridge';

const ADAPTER_ID = 'codex-cli';

/**
 * Codex CLI 适配器（基于 @openai/codex-sdk）。
 *
 * 能力边界（与 plan 对齐）：
 * - ✅ createSession / sendMessage / interrupt / resume / 事件流
 * - ❌ canUseTool 等价回调（codex SDK 是单工通道，approvalPolicy 是字符串枚举一次性配置）
 * - ❌ AskUserQuestion / ExitPlanMode（codex 没有这些工具/状态机）
 * - ❌ 运行时 setPermissionMode（approvalPolicy 仅在 startThread 时设一次）
 * - ❌ installIntegration / hook（codex 没有 hook 机制）
 *
 * 默认安全策略：approvalPolicy 写死 'never'（codex SDK 不支持 canUseTool 等价回调，
 * 无法运行时审批）；sandboxMode 默认 'workspace-write' 但**可被 settings.codexSandbox 覆盖**
 * （CHANGELOG_54 B-4：补齐 REVIEW_14「双 backend 沙盒对称」目标，让用户能在 read-only /
 * workspace-write / danger-full-access 三档间切）。靠 OS sandbox 兜底。
 *
 * 二进制：随 @openai/codex-sdk 装上 @openai/codex（含 vendored 平台二进制 ~150MB），
 * 跟随 .app 走。用户可在设置面板填 codexCliPath 覆盖为外部 codex（如自装的更新版本）。
 */
class CodexCliAdapterImpl implements AgentAdapter {
  id = ADAPTER_ID;
  displayName = 'Codex CLI';
  capabilities = {
    canCreateSession: true,
    canInterrupt: true,
    canSendMessage: true,
    canInstallHooks: false,
    canRespondPermission: false,
    canSetPermissionMode: false,
    canRestartWithPermissionMode: false,
    canCloseSession: true,
    // Codex 不走 Claude Code CLI，没有 agent teams 概念。
    canJoinTeam: false,
  };

  private bridge: CodexSdkBridge | null = null;

  async init(ctx: AdapterContext): Promise<void> {
    this.bridge = new CodexSdkBridge({ emit: ctx.emit });
    // 启动时读一次 codexCliPath / codexSandbox，给 bridge
    this.bridge.setCodexCliPath(settingsStore.get('codexCliPath'));
    this.bridge.setCodexSandboxMode(settingsStore.get('codexSandbox'));
    // 不注册 hook routes：codex 没有 hook 通道
  }

  async shutdown(): Promise<void> {
    // 没有需要主动关闭的资源（codex SDK 子进程是 per-turn spawn，turn 结束自动清理）
  }

  async createSession(opts: {
    cwd: string;
    prompt?: string;
    model?: string;
    permissionMode?: PermissionMode; // 收下但忽略：codex 不支持运行时 permission mode
    resume?: string;
  }): Promise<string> {
    if (!this.bridge) throw new Error('codex-cli adapter not initialized');
    const handle = await this.bridge.createSession({
      cwd: opts.cwd,
      prompt: opts.prompt,
      model: opts.model,
      resume: opts.resume,
    });
    return handle.sessionId;
  }

  async interruptSession(sessionId: string): Promise<void> {
    if (!this.bridge) return;
    await this.bridge.interrupt(sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!this.bridge) return;
    await this.bridge.closeSession(sessionId);
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    if (!this.bridge) throw new Error('codex-cli adapter not initialized');
    await this.bridge.sendMessage(sessionId, text);
  }

  listPending(sessionId: string): {
    permissions: never[];
    askQuestions: never[];
    exitPlanModes: never[];
  } {
    if (!this.bridge) return { permissions: [], askQuestions: [], exitPlanModes: [] };
    return this.bridge.listPending(sessionId);
  }

  listAllPending(): Record<
    string,
    { permissions: never[]; askQuestions: never[]; exitPlanModes: never[] }
  > {
    if (!this.bridge) return {};
    return this.bridge.listAllPending();
  }

  /** Codex 专属：设置面板「Codex 二进制路径」变更时即改即生效。 */
  setCodexCliPath(path: string | null): void {
    this.bridge?.setCodexCliPath(path);
  }

  /** Codex 专属：设置面板「Codex 沙盒档位」变更；下次新建会话生效。 */
  setCodexSandboxMode(mode: 'workspace-write' | 'read-only' | 'danger-full-access'): void {
    this.bridge?.setCodexSandboxMode(mode);
  }

  // 不实现：respondPermission / respondAskUserQuestion / respondExitPlanMode /
  // setPermissionMode / setPermissionTimeoutMs / installIntegration /
  // uninstallIntegration / integrationStatus —— capabilities 已表明不支持
}

export const codexCliAdapter: AgentAdapter = new CodexCliAdapterImpl();
