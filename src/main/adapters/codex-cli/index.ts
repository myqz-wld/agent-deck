import type { AgentAdapter, AdapterContext, CodexCreateOpts } from '../types';
import type { AgentEvent, UploadedAttachmentRef } from '@shared/types';
import { settingsStore } from '@main/store/settings-store';
import { CodexSdkBridge } from './sdk-bridge';
import { summariseCodexSessionViaOneshot } from './summarizer-runner';
import { summariseCodexSessionForHandOff } from './handoff-runner';
import { formatEventsForPrompt } from '@main/session/summarizer/event-formatter';

const ADAPTER_ID = 'codex-cli';

/**
 * Codex CLI 适配器（基于 `codex app-server --stdio`）。
 *
 * 能力边界（与 plan 对齐）：
 * - ✅ createSession / sendMessage / interrupt / resume / 事件流
 * - ❌ canUseTool 等价回调（Codex approvalPolicy 是字符串枚举一次性配置）
 * - ❌ AskUserQuestion / ExitPlanMode（codex 没有这些工具/状态机）
 * - ❌ 运行时 setPermissionMode（approvalPolicy 仅在 startThread 时设一次）
 * - ❌ installIntegration / hook（codex 没有 hook 机制）
 *
 * 默认安全策略：approvalPolicy 写死 'never'（Codex 不支持 canUseTool 等价回调，
 * 无法运行时审批）；sandboxMode 默认 'workspace-write' 但**可被 settings.codexSandbox 覆盖**
 * （CHANGELOG_54 B-4：补齐 REVIEW_14「双 backend 沙盒对称」目标，让用户能在 read-only /
 * workspace-write / danger-full-access 三档间切）。靠 OS sandbox 兜底。
 *
 * 二进制：直接依赖 @openai/codex（含 vendored 平台二进制 ~150MB），
 * 跟随 .app 走。用户可在设置面板填 codexCliPath 覆盖为外部 codex（如自装的更新版本）。
 */
class CodexCliAdapter implements AgentAdapter {
  id = ADAPTER_ID;
  displayName = 'Codex CLI';
  capabilities = {
    canCreateSession: true,
    canInterrupt: true,
    canSendMessage: true,
    canSteerTurn: true,
    canInstallHooks: false,
    canRespondPermission: false,
    canSetPermissionMode: false,
    canRestartWithPermissionMode: false,
    // CHANGELOG_<X> A2b：codex 专属冷切，restartWithCodexSandbox 走 close + resumeThread
    // 重建 thread 透传新 sandbox（spike-A2 实测 SDK + CLI 透传新 sandbox 真生效）。
    canRestartWithCodexSandbox: true,
    // CHANGELOG_74：codex 不支持 claude-code OS 沙盒冷切（claude 专属 capability）。
    canRestartWithClaudeCodeSandbox: false,
    canCloseSession: true,
    // R3.E4：universal team backend 接收 cross-adapter 消息（receiveTeammateMessage = sendMessage）
    canCollaborate: true,
    // REVIEW_35 HIGH-D2：codex SDK 接收 image content blocks
    canAcceptAttachments: true,
  };

  /**
   * codex bridge 实例。
   *
   * **可见性**（plan codex-handoff-team-alignment-20260518 P2 Step 2.8）：从 `private` 改为
   * 默认（class 内部字段无访问修饰符 = public）让 main bootstrap 注入的
   * `setSessionRenameHookFn` 能 cast access `adapter.bridge?.renameCodexInstance` 同步 rename
   * codexBySession Map key(不变量 7:sessionManager.renameSdkSession 函数体内统一调,
   * 与 sdkOwned / token map / sessions Map / per-session Codex 实例 Map 四处 key 同步)。
   *
   * 不加进 AgentAdapter interface(避免 claude adapter 也得 noop 实现一份污染契约) —
   * codex 是唯一需要 per-session bridge instance rename 的 adapter,通过 cast 探测特化。
   */
  bridge: CodexSdkBridge | null = null;

  async init(ctx: AdapterContext): Promise<void> {
    // CHANGELOG_<X> R2 / B'4：把 ctx.hookServer 传给 bridge，让 ensureCodex 在 spawn
    // codex CLI 时通过 SDK config 字段注入 mcp_servers.agent-deck（连接到本应用 /mcp）。
    this.bridge = new CodexSdkBridge({ emit: ctx.emit, hookServer: ctx.hookServer });
    // 启动时读一次 codexCliPath，给 bridge（codexSandbox 不再透传：bridge createSession
    // 已直接 settingsStore.get('codexSandbox')，与 claude-code adapter 的 sandbox-resolve
    // 同款直读模式 — symmetry-plan P2 MED-B 删 currentSandboxMode in-memory mirror）
    this.bridge.setCodexCliPath(settingsStore.get('codexCliPath'));
    // 不注册 hook routes：codex 没有 hook 通道
  }

  async shutdown(): Promise<void> {
    // 没有需要主动关闭的资源（codex SDK 子进程是 per-turn spawn，turn 结束自动清理）
  }

  async createSession(opts: CodexCreateOpts & { agentId: 'codex-cli' }): Promise<string> {
    if (!this.bridge) throw new Error('codex-cli adapter not initialized');
    const handle = await this.bridge.createSession({
      cwd: opts.cwd,
      prompt: opts.prompt,
      resume: opts.resume,
      codexSandbox: opts.codexSandbox,
      attachments: opts.attachments,
      model: opts.model,
      modelReasoningEffort: opts.modelReasoningEffort,
      extraAllowWrite: opts.extraAllowWrite,
      // plan codex-handoff-team-alignment-20260518 §P3 Step 3.5: 4 个新字段（codex teammate
      // spawn default 由 options-builder narrowToCodexOpts spread；此处只透传不主动 enforce）
      approvalPolicy: opts.approvalPolicy,
      networkAccessEnabled: opts.networkAccessEnabled,
      additionalDirectories: opts.additionalDirectories,
      envOverrideExtra: opts.envOverrideExtra,
      // plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.2 第 7 步(facade wrapper):
      // 显式 spread handOff,否则 facade 白名单 spread 会丢字段 → bridge 拿不到 metadata。
      handOff: opts.handOff,
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

  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
  ): Promise<void> {
    if (!this.bridge) throw new Error('codex-cli adapter not initialized');
    await this.bridge.sendMessage(sessionId, text, attachments);
  }

  async steerTurn(sessionId: string, text: string): Promise<void> {
    if (!this.bridge) throw new Error('codex-cli adapter not initialized');
    await this.bridge.steerTurn(sessionId, text);
  }

  /**
   * R3.E4：receiveTeammateMessage = 调本 adapter 的 sendMessage。
   * watcher 已在 body 里拼好 `[from <displayName> @ <adapterId>]` 前缀，直接透传。
   * fromMemberId 仅用于 logging。
   *
   * 注意 §7.5 backpressure 配套：codex SDK 的 MAX_PENDING_MESSAGES=20 队列有上限，
   * watcher 的 mcpMessageMaxTargetInflight 设默认 10 防灌爆（settings 可调）。
   */
  async receiveTeammateMessage(
    sessionId: string,
    _fromMemberId: string,
    body: string,
  ): Promise<void> {
    if (!this.bridge) throw new Error('codex-cli adapter not initialized');
    await this.bridge.sendMessage(sessionId, body);
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

  /**
   * Codex 专属冷切（CHANGELOG_<X> A2b）：销毁旧 thread + 用新 sandbox 档位 resume 重建。
   * SDK sandboxMode 是 startThread/resumeThread spawn-time 锁定，必须冷切。
   * 失败时 bridge 内部已 emit error message + 回滚 sessionRepo.codexSandbox。
   */
  async restartWithCodexSandbox(
    sessionId: string,
    sandbox: 'workspace-write' | 'read-only' | 'danger-full-access',
    handoffPrompt: string,
  ): Promise<string> {
    if (!this.bridge) throw new Error('codex-cli adapter not initialized');
    return this.bridge.restartWithCodexSandbox(sessionId, sandbox, handoffPrompt);
  }

  /**
   * R37 P2-I Step 3.3：LLM 驱动的「最近做什么」入口（dispatch 下放）。
   *
   * - 'summary' → `summariseCodexSessionViaOneshot` ('low' effort，settings.summaryTimeoutMs)
   * - 'handoff' → `summariseCodexSessionForHandOff` ('medium' effort，60s timeout hardcoded)
   *
   * 两个 codex runner 都需 caller 注入 `formatEventsForPrompt`（避免 codex/ 子目录反向
   * import @main/session/summarizer/event-formatter；adapter 在此一处统一注入）。
   */
  async summariseEvents(
    cwd: string,
    events: AgentEvent[],
    kind: 'summary' | 'handoff',
  ): Promise<string | null> {
    return kind === 'summary'
      ? summariseCodexSessionViaOneshot(cwd, events, formatEventsForPrompt)
      : summariseCodexSessionForHandOff(cwd, events, formatEventsForPrompt);
  }

  // 不实现：respondPermission / respondAskUserQuestion / respondExitPlanMode /
  // setPermissionMode / setPermissionTimeoutMs / installIntegration /
  // uninstallIntegration / integrationStatus —— capabilities 已表明不支持
}

/**
 * Typed export（D2）：caller `adapterRegistry.get('codex-cli')` 拿到本 class 实例后,
 * 自动暴露 codex 专属方法（restartWithCodexSandbox / setCodexCliPath 等）TS visible。
 */
export type { CodexCliAdapter };
export const codexCliAdapter: CodexCliAdapter = new CodexCliAdapter();
