import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type {
  CanUseTool,
  PermissionResult,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionRequest,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  PermissionRequest,
  PermissionResponse,
} from '@shared/types';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { settingsStore } from '@main/store/settings-store';
import { eventBus } from '@main/event-bus';
import { getSdkRuntimeOptions, getPathToClaudeCodeExecutable } from '@main/adapters/claude-code/sdk-runtime';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import {
  getAgentDeckPluginsForSession,
  getAgentDeckSystemPromptAppend,
} from '@main/adapters/claude-code/sdk-injection';
import { buildSandboxOptions } from '@main/adapters/claude-code/sandbox-config';
import { getTasksMcpServerForSession } from '@main/task-manager/server';
import { formatAskAnswers } from '@main/adapters/claude-code/sdk-bridge-helpers';
// CHANGELOG_52 Step 3a：抽出 constants / types / sdk-message-translate 三个最纯净模块。
// class state 不动，原 ClaudeSdkBridge.translate / maybeEmitFileChanged /
// maybeEmitImageFileChanged 三个 private 方法改为薄 wrapper 调 module function。
import {
  AGENT_ID,
  MAX_MESSAGE_BYTES,
  MAX_PENDING_MESSAGES,
  PLACEHOLDER_DEDUP_MS,
  READ_ONLY_TOOLS,
} from '@main/adapters/claude-code/sdk-bridge/constants';
import type {
  InternalSession,
  PendingAskQuestionEntry,
  PendingExitPlanModeEntry,
  PendingPermissionEntry,
  SdkBridgeOptions,
  SdkSessionHandle,
} from '@main/adapters/claude-code/sdk-bridge/types';
import { translateSdkMessage } from '@main/adapters/claude-code/sdk-bridge/sdk-message-translate';

export type { SdkSessionHandle, SdkBridgeOptions } from '@main/adapters/claude-code/sdk-bridge/types';

/**
 * SDK 通道实现：每个 session 启动一个 query() AsyncGenerator，
 * 把 SDKMessage 流翻译为 AgentEvent。
 *
 * 设计要点：
 * 1. 启用 settingSources: ['user','project','local']，让会话等价于在该 cwd
 *    跑 `claude`（复用本地 hooks / MCP / agents / permissions）。
 * 2. SDK 真实 session_id 由 SDKMessage 携带，不能预先生成。createSession
 *    会等第一条 SDKMessage 拿到 session_id 后再返回，并把它登记到
 *    sessionManager 的 sdk-owned 集合，让来自 hook 回环的同 id 事件被去重。
 * 3. 所有 emit 都打 source: 'sdk'。
 */
export class ClaudeSdkBridge {
  /** key 是真实 session_id（拿到之前用临时 id） */
  private sessions = new Map<string, InternalSession>();
  /**
   * sendMessage 走「断连自愈」路径时的单飞表（CHANGELOG_26 / B 方案）：
   *   sessionId → 正在跑的 createSession({resume,prompt}) Promise
   *
   * 同 sessionId 并发触发 sendMessage 时，第二条等同一个 Promise，避免 H4 修过的
   * `claimAsSdk(opts.resume)` 被同 sessionId 多次重入造成 sdkOwned 状态错乱、
   * 或者并发起多条 SDK query 导致 Anthropic 端按次计费 + 消息在两个 stream 里乱序。
   *
   * 「单飞」语义：拿到 inflight 后等它完成，然后**重新走完整 sendMessage 流程**，
   * 把这条新 text 正常 push 进 sessions Map 上的 pendingUserMessages，避免 createSession
   * 内只有「触发恢复的那条 prompt」被消费而后续等 inflight 的消息被丢。
   */
  private recovering = new Map<string, Promise<unknown>>();
  /**
   * REVIEW_17 R3 / M3-R3：recoverAndSend 入口 emit 占位 message 的 dedup 窗口。
   * 同 sessionId 短时间内被多次 recover 触发（首次 inflight 失败 swallow + 再次
   * sendMessage 重新进 recoverAndSend）会 emit 多条「⚠ SDK 通道已断开...」噪声。
   * 5s 窗口够覆盖单飞失败到下次 sendMessage 的典型间隔。
   */
  private placeholderEmittedAt = new Map<string, number>();
  // CHANGELOG_52 Step 3a：PLACEHOLDER_DEDUP_MS 从 class static 提到 module 级 const（constants.ts），
  // 让 3d 抽 recoverer 时能直接 import；引用从 PLACEHOLDER_DEDUP_MS 改成 module-level。
  /** 权限请求未响应自动 abort 阈值；0 = 关闭。运行时通过 setPermissionTimeoutMs 改。 */
  private permissionTimeoutMs: number;

  constructor(private opts: SdkBridgeOptions) {
    this.permissionTimeoutMs = Math.max(0, opts.permissionTimeoutMs ?? 0);
  }

  /** 调整超时阈值。0 = 关闭。只影响新建的 pending；老的保持原 timer。 */
  setPermissionTimeoutMs(ms: number): void {
    this.permissionTimeoutMs = Math.max(0, ms);
  }

  async createSession(opts: {
    cwd: string;
    prompt?: string;
    model?: string;
    permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
    /** 传 sessionId 表示恢复历史会话（CLI 会从 ~/.claude/projects/<cwd>/<sid>.jsonl 续上）。 */
    resume?: string;
    /**
     * Agent Teams 团队名（详见 CreateSessionOptions.teamName 注释）。非空 + agentTeamsEnabled
     * 时触发 query env 注入 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1。resume 路径下传 teamName
     * 视为非法（Anthropic 官方明确「Agent Teams 不支持 session resumption」）。
     */
    teamName?: string;
  }): Promise<SdkSessionHandle> {
    // SDK streaming 协议硬性约束：必须有首条 user message 才会启动 CLI 子进程，
    // 否则 stdin 永远等不到数据 → CLI 不动 → SDK 不发 SDKMessage → 30s 兜底超时。
    // UI 已强制必填，这里再守一道，避免 IPC 直调时静默卡死。
    if (!opts.prompt || !opts.prompt.trim()) {
      throw new Error('首条消息不能为空：SDK streaming 模式需要首条消息才能启动 CLI');
    }
    // CHANGELOG_46：放开 resume + teamName 的应用层 block。
    //
    // 历史背景：之前 NewSessionDialog 让用户预填 teamName，应用 IPC 入口预写 sessions.team_name
    // 后 lead 启动；resume 时调用方仍传 teamName → 应用 throw 阻断（防 SDK 上游 resume +
    // teammate 状态机崩）。
    //
    // 现在 NewSessionDialog 已删 teamName 输入框，team 由 lead 自由建后通过 team-coordinator
    // 反向同步 sessions.team_name；resume 路径调用方（recoverAndSend）也不传 teamName。所以
    // 这条 throw 实际不会被新代码路径触发。
    //
    // 仅 CLI 入口 `agent-deck new --team-name X` resume 时仍会传 teamName —— 留 console.warn
    // 提醒上游 SDK 的 resume limitation（lead 可能给已死 teammate 发消息），但不再 block；
    // 让用户自己决定是否承担风险。SDK 真崩用户能从错误信息看到，应用层不替用户拍板。
    if (opts.resume && opts.teamName && opts.teamName.trim().length > 0) {
      console.warn(
        `[sdk-bridge] resume + teamName='${opts.teamName.trim()}'：Anthropic Agent Teams ` +
          '实验特性官方不支持 /resume，lead 可能给已死 teammate 发消息导致 CLI 状态机异常。' +
          '应用不再 block，上游真崩时请新建 team 会话。',
      );
    }
    const tempKey = randomUUID();
    // 时序保护：CLI 子进程内部 hook 可能先于 SDK 通道首条 SDKMessage 到达，
    // 提前注册 cwd「待领取」标记，让 sessionManager 把首发的同 cwd hook 事件
    // 自动归到 SDK，避免出现「内/外」两份重复会话。
    //
    // 注意：releasePending 必须在「成功 + 失败」两条路径都释放，否则失败时
    // pending cwd 会卡 60s ttl，期间同 cwd 的真实外部 hook 会话被误吞。
    // 整段 createSession 用 try/catch 包，catch 里清掉 sessions map 并 release。
    const releasePending = sessionManager.expectSdkSession(opts.cwd);

    // REVIEW_5 H4：resume 路径下 cwd 待领取兜底**失效**（dedupOrClaim 第二道仅对
    // `!sessionRepo.get(id)` 起作用，OLD_ID 在历史 DB 里一定存在），CLI 内部 hook 抢先
    // 上报 SessionStart 时会直接 ensure→revive 出一条 cli source 的 active record，
    // 与稍后 SDK 30s fallback 用 tempKey 又造的另一条 active record 在 SessionList
    // 显示成「两条 active 看起来一样的会话」（用户报项 + 双对抗 ✅）。
    //
    // 修法：进入即把 opts.resume 提前 claim 到 sdkOwned，hook 进 ingest 时
    // 第一道防线 `sdkOwned.has(event.sessionId)` 直接 skip。配合下方 fallback 用
    // opts.resume 作 sessionId 不再造 tempKey 占位行，根治两条 active record。
    if (opts.resume) {
      sessionManager.claimAsSdk(opts.resume);
    }
    const internal: InternalSession = {
      realSessionId: null,
      cwd: opts.cwd,
      query: undefined as unknown as Query,
      pendingUserMessages: [],
      notify: null,
      pendingPermissions: new Map(),
      pendingAskUserQuestions: new Map(),
      pendingExitPlanModes: new Map(),
      toolUseNames: new Map(),
    };

    if (opts.prompt) {
      // 用 tempKey 占位 session_id，实际 SDK 会忽略这个字段（用自己的）
      internal.pendingUserMessages.push(this.makeUserMessage(tempKey, opts.prompt));
    }

    const userMessageIterable = this.createUserMessageStream(internal, tempKey);

    // 鉴权 / 模型映射 / 代理地址等都来自 ~/.claude/settings.json 的 env 字段，
    // 由 main bootstrap 阶段的 applyClaudeSettingsEnv() 注入到 process.env，
    // SDK spawn 的 CLI 子进程会继承，与终端 `claude` 用同一套配置。

    const canUseTool: CanUseTool = async (toolName, input, ctx) => {
      const realId = internal.realSessionId ?? tempKey;
      const requestId = randomUUID();

      // REVIEW_11 Bug 4：read-only 工具白名单，任何 permissionMode 下都直接放行。
      // SDK 0.2.x 设计：注册 canUseTool 后，CLI 对所有工具调用都丢给应用决策（包括 Read /
      // Grep / Glob / LS / WebFetch / WebSearch / TodoWrite / NotebookRead 这些只读 / 元数据类
      // 工具）。应用之前没做白名单 → default mode 下用户被 Read / Grep 等无害操作反复弹询问，
      // 体感「default mode 跟 plan mode 没区别都要审核」。
      // 白名单内的工具语义上不会改变文件系统 / 不会执行外部命令，截胡放行无安全风险，且与
      // SDK 行为不冲突（SDK 文档明确：注册 canUseTool 即表示决定权完全归应用）。
      // MCP 图片读取类工具（命名约定 mcp__xxx__ImageRead 或后缀 __ImageRead）同样白名单。
      if (READ_ONLY_TOOLS.has(toolName) || toolName.endsWith('__ImageRead')) {
        return { behavior: 'allow', updatedInput: input };
      }

      // REVIEW_14 阶段 2 + REVIEW_15 实证：SandboxNetworkAccess 自动透明 deny。
      //
      // 实测机制（dev 验证 [canusetool] log + 用户给 proxy `403 + X-Proxy-Error:
      // blocked-by-allowlist` 头实证）：
      // sandbox 启用后 SDK 网络拦截是**双层并行**：
      //
      // 1. **应用层 SandboxNetworkAccess 工具回路**：SDK 调内置 `SandboxNetworkAccess`
      //    工具向 canUseTool 申请「是否放行该 host」（payload `{host: 'example.com'}`）
      // 2. **OS/proxy 层执行**：SDK 同时启本地 HTTP CONNECT proxy + 注入 `https_proxy`
      //    env，按 allowedDomains allowlist 实际拦截（curl 拿 `403 Forbidden`）
      //
      // 不修法走 SDK 默认行为时，SandboxNetworkAccess 工具会**弹给用户审批每个 host**
      //（spike 阶段实测见用户截图），加上 model fallback `dangerouslyDisableSandbox: true`
      // 那次的 Bash 弹框，用户视角是「同一个 curl 弹两次」，UX 噪声大、语义还相反。
      //
      // 修法（本分支）：第 1 次直接 deny + 结构化 message → model **100% 按指引**
      // fallback 走 dangerouslyDisableSandbox 重试（不是概率性 reasoning，是协议级稳定路径）
      // → 第 2 次 Bash 弹给用户审批（保留这一次是合理的：model 主动绕沙盒确实需要用户拍板）。
      // 实测 UX：仅 1 次弹框给用户。
      //
      // strict 档因 `allowUnsandboxedCommands: false` 直接封死逃逸路径，model fallback
      // dangerouslyDisableSandbox 也会被 SDK 直接忽略，最终 model 报「无法联网」给用户
      // —— 此分支同样适用，不弹给用户。
      if (toolName === 'SandboxNetworkAccess') {
        const host =
          typeof (input as { host?: unknown })?.host === 'string'
            ? (input as { host: string }).host
            : '<unknown>';
        // 保留此 log 一行：sandbox 启用时每次 host 拦截打一行，可见性高、噪声可控
        // （比每次 canUseTool 都打 log 强）。出问题时一目了然「sandbox 真在拦哪些 host」。
        console.log(`[sandbox-canusetool] SandboxNetworkAccess intercept host=${host} → auto-deny + fallback hint`);
        return {
          behavior: 'deny',
          message:
            `网络访问被沙盒拦截（host: ${host}）。如确实需要联网，请用 Bash + ` +
            `dangerouslyDisableSandbox: true 参数重试（会触发用户审批）。` +
            `如档位为 strict 则逃逸已被禁用，请告知用户切档位或换无网方案。`,
          interrupt: false,
        };
      }

      // 特殊路径：AskUserQuestion 不是「危险工具需要批准」，是 Claude 主动征询用户。
      // 走独立 UI（带选项按钮）→ 用户选完 → 把答案塞进 deny.message 反馈给 Claude
      // （Claude 收到 tool_result 含答案，会基于这个继续对话）。
      if (toolName === 'AskUserQuestion') {
        const inAsked = (input as { questions?: AskUserQuestionItem[] }) ?? {};
        const questions = Array.isArray(inAsked.questions) ? inAsked.questions : [];
        const toolUseId = (ctx as { tool_use_id?: string }).tool_use_id;
        const askPayload: AskUserQuestionRequest = {
          type: 'ask-user-question',
          requestId,
          toolUseId,
          questions,
        };
        this.opts.emit({
          sessionId: realId,
          agentId: AGENT_ID,
          kind: 'waiting-for-user',
          payload: askPayload,
          ts: Date.now(),
          source: 'sdk',
        });
        return new Promise<PermissionResult>((resolve) => {
          const entry: PendingAskQuestionEntry = {
            payload: askPayload,
            timer: null,
            resolver: (answer) => {
              if (entry.timer) clearTimeout(entry.timer);
              const text = formatAskAnswers(questions, answer);
              resolve({
                behavior: 'deny',
                message:
                  `用户已通过 UI 选择，请把以下回答视为他们对这次 AskUserQuestion 的回复，` +
                  `继续按用户意图执行：\n\n${text}`,
                interrupt: false,
              });
            },
          };
          internal.pendingAskUserQuestions.set(requestId, entry);
          // 超时自动拒：避免 SDK 永远卡在等用户回答（窗口关掉 / store 丢状态等）。
          if (this.permissionTimeoutMs > 0) {
            entry.timer = setTimeout(() => {
              this.timeoutAskUserQuestion(realId, requestId);
            }, this.permissionTimeoutMs);
          }
          ctx.signal?.addEventListener('abort', () => {
            const cur = internal.pendingAskUserQuestions.get(requestId);
            if (cur) {
              if (cur.timer) clearTimeout(cur.timer);
              internal.pendingAskUserQuestions.delete(requestId);
              // 通知 UI：这条提问已被 SDK 取消（通常是 query 流终止 / 上层 interrupt）。
              // 不发也行，但 UI 会一直显示选项却点了没用。
              this.opts.emit({
                sessionId: realId,
                agentId: AGENT_ID,
                kind: 'waiting-for-user',
                payload: { type: 'ask-question-cancelled', requestId },
                ts: Date.now(),
                source: 'sdk',
              });
              resolve({ behavior: 'deny', message: 'aborted', interrupt: true });
            }
          });
        });
      }

      // 特殊路径：ExitPlanMode —— plan mode 下 Claude 完成规划，向用户提议「请批准执行」。
      // 跟 AskUserQuestion 一样走独立通路：UI 用 markdown 渲染 plan + 二选一按钮。
      // - 批准（approve）→ allow + updatedInput 不变，CLI 内部退出 plan mode 开始执行
      // - 继续规划（keep-planning）→ deny + message（含可选用户反馈），Claude 留在 plan mode 修
      if (toolName === 'ExitPlanMode') {
        const inExit = (input as { plan?: unknown }) ?? {};
        const plan = typeof inExit.plan === 'string' ? inExit.plan : '';
        const toolUseId = (ctx as { tool_use_id?: string }).tool_use_id;
        const exitPayload: ExitPlanModeRequest = {
          type: 'exit-plan-mode',
          requestId,
          toolUseId,
          plan,
        };
        this.opts.emit({
          sessionId: realId,
          agentId: AGENT_ID,
          kind: 'waiting-for-user',
          payload: exitPayload,
          ts: Date.now(),
          source: 'sdk',
        });
        return new Promise<PermissionResult>((resolve) => {
          const entry: PendingExitPlanModeEntry = {
            payload: exitPayload,
            toolInput: (input as Record<string, unknown>) ?? {},
            timer: null,
            resolver: (response) => {
              if (entry.timer) clearTimeout(entry.timer);
              if (response.decision === 'approve' && response.targetMode === 'plan') {
                // REVIEW_11 Bug 3：「批准并保持 Plan 模式」是协议级特例。
                // SDK / CLI 把「ExitPlanMode 工具被 allow」语义性视为「用户同意退出 plan」，
                // 一旦 allow，CLI 内部状态机立刻翻出 plan，外层后续 setPermissionMode('plan')
                // 跑在 CLI 已退档之后属于 CHANGELOG_47 同病灶（post-allow 时序静默吞档）。
                // 修法：approve+plan 不走 allow，改 deny+message：让 CLI 留在 plan 不退档，
                // 同时通过 message 告诉 Claude「计划已被认可，但用户希望继续在 plan 模式推进」。
                // message 文案要明确「不要立刻再次调用 ExitPlanMode」避免 plan→deny→plan 死循环。
                resolve({
                  behavior: 'deny',
                  message:
                    `用户已认可你的计划，但要求你继续在 plan 模式下推进` +
                    `（继续细化方案 / 补充信息 / 等待进一步指示，**不要执行任何编辑或写入操作**）。\n\n` +
                    `如果用户后续要求实施，请等他们主动切换到 default / acceptEdits / bypass 之后再操作，` +
                    `**不要在本会话内立刻再次调用 ExitPlanMode**（用户还想停留在 plan 模式继续讨论）。`,
                  interrupt: false,
                });
              } else if (response.decision === 'approve') {
                // 热切档（approve + targetMode ∈ {default, acceptEdits}）：
                // allow + 原 input 透传 —— 让 ExitPlanMode 工具调用「成功」，
                // CLI 收到 tool_result 自动退出 plan mode，后续工具按 targetMode 继续
                // （targetMode 由外层 respondExitPlanMode 在 resolver 后同步调
                // s.query.setPermissionMode(targetMode) + sessionRepo 写入；
                // SDK Query 在下次工具调用前应用新 mode）。
                resolve({
                  behavior: 'allow',
                  updatedInput: entry.toolInput,
                });
              } else if (response.decision === 'approve-bypass') {
                // 冷切档：deny + interrupt:true —— 让 OLD CLI 子进程的当前 turn 立即中止，
                // 避免「allow 后 SDK 立刻吐 tool_use 跟正在重启的子进程抢 jsonl flush」race
                // （双 Agent 对抗一致结论；race 触发后用户体感「批准了 plan 但 NEW session 又
                // 重新进 plan mode」，磁盘 IO 抖动导致无法稳定复现）。
                // OLD turn 中止后由外层 respondExitPlanMode 调 restartWithPermissionMode，
                // 用 plan 文本作 handoff prompt 让 Claude 在 bypass 模式重新执行。
                resolve({
                  behavior: 'deny',
                  message: '用户已批准 plan 并切换到 bypassPermissions 模式，正在重启子进程重新执行',
                  interrupt: true,
                });
              } else {
                // keep-planning：保留原逻辑
                const fb = response.feedback?.trim();
                resolve({
                  behavior: 'deny',
                  message:
                    `用户希望继续完善计划，请基于以下反馈修改后再调用 ExitPlanMode 提交新版本：\n\n` +
                    `反馈：${fb || '(用户未填写具体反馈，请主动询问需要补充哪方面)'}`,
                  interrupt: false,
                });
              }
            },
          };
          internal.pendingExitPlanModes.set(requestId, entry);
          if (this.permissionTimeoutMs > 0) {
            entry.timer = setTimeout(() => {
              this.timeoutExitPlanMode(realId, requestId);
            }, this.permissionTimeoutMs);
          }
          ctx.signal?.addEventListener('abort', () => {
            const cur = internal.pendingExitPlanModes.get(requestId);
            if (cur) {
              if (cur.timer) clearTimeout(cur.timer);
              internal.pendingExitPlanModes.delete(requestId);
              this.opts.emit({
                sessionId: realId,
                agentId: AGENT_ID,
                kind: 'waiting-for-user',
                payload: { type: 'exit-plan-cancelled', requestId },
                ts: Date.now(),
                source: 'sdk',
              });
              resolve({ behavior: 'deny', message: 'aborted', interrupt: true });
            }
          });
        });
      }

      const permPayload: PermissionRequest = {
        type: 'permission-request',
        requestId,
        toolName,
        toolInput: input as Record<string, unknown>,
        suggestions: ctx.suggestions,
      };
      this.opts.emit({
        sessionId: realId,
        agentId: AGENT_ID,
        kind: 'waiting-for-user',
        payload: permPayload,
        ts: Date.now(),
        source: 'sdk',
      });
      return new Promise<PermissionResult>((resolve) => {
        const entry: PendingPermissionEntry = {
          payload: permPayload,
          resolver: resolve,
          timer: null,
        };
        internal.pendingPermissions.set(requestId, entry);
        if (this.permissionTimeoutMs > 0) {
          entry.timer = setTimeout(() => {
            this.timeoutPermission(realId, requestId);
          }, this.permissionTimeoutMs);
        }
        ctx.signal?.addEventListener('abort', () => {
          const cur = internal.pendingPermissions.get(requestId);
          if (cur) {
            if (cur.timer) clearTimeout(cur.timer);
            internal.pendingPermissions.delete(requestId);
            // 通知 UI：SDK 已放弃这次请求（超时 / interrupt / 流终止），
            // 让活动流和 banner 把这条权限请求清掉，不再让用户点了没反应。
            this.opts.emit({
              sessionId: realId,
              agentId: AGENT_ID,
              kind: 'waiting-for-user',
              payload: { type: 'permission-cancelled', requestId },
              ts: Date.now(),
              source: 'sdk',
            });
            resolve({ behavior: 'deny', message: 'aborted', interrupt: true });
          }
        });
      });
    };

    // 整段 await 链（loadSdk → query 构造 → waitForRealSessionId）任一步抛错都要
    // 释放 pending cwd 标记 + 清掉 sessions map 的 tempKey。CHANGELOG_47 修：
    // 之前 releasePending 只在成功路径调，失败时 60s ttl 内同 cwd 真实外部 hook 会话被误吞。
    let realId: string;
    try {
      const { query } = await loadSdk();
      const runtime = getSdkRuntimeOptions();
      const claudeBinary = getPathToClaudeCodeExecutable();
      // REVIEW_14 阶段 2 排查盲点：sandbox 是否生效在 SDK / OS 层不打 log，应用主进程
      // 看不到「sandbox 装载成功 / 失败」信号；改回顶层 sandbox 字段后此 log 帮助
      // 实证「buildSandboxOptions 真的传了对应配置进 SDK options」，下次问题排查少绕一圈。
      const sandboxOpts = buildSandboxOptions(
        settingsStore.get('claudeCodeSandbox') ?? 'off',
        opts.cwd,
      );
      console.log(
        `[sandbox] mode=${settingsStore.get('claudeCodeSandbox') ?? 'off'} → ${
          sandboxOpts.sandbox ? 'enabled (top-level)' : 'disabled (no field)'
        }`,
      );
      // Task Manager（CHANGELOG_43）：开关开 → 构造 per-session in-process MCP server，
      // teamName 通过 lazy 工厂闭包注入到 5 个 task tool（CHANGELOG_46 改 lazy：createSession
      // 入口不再知道 team 名，由 team-coordinator 反向同步后从 sessionRepo 拿；每次工具调用
      // 时调一次工厂反映最新值）。开关关 → 不传 mcpServers / allowedTools。
      // mcpServers 需要在 spawn 前 await 拿到 server instance，所以放在 query() 调用之前
      // （loadSdk 已 cache，复用同 SDK 实例）。
      const enableTaskManager = settingsStore.get('enableTaskManager') === true;
      // realId 此时还没拿到（在 waitForRealSessionId 之后才有）；用 tempKey 兜底，等 realId
      // 出现后 sessionRepo.get(realId) 自然能拿到 team_name。tempKey 阶段 sessionRepo.get 返
      // null 是预期行为（team_name 走 null 分支，task tools 内部不强制要求 team）。
      const tasksServer = enableTaskManager
        ? await getTasksMcpServerForSession(() => {
            const sid = internal.realSessionId ?? tempKey;
            return sessionRepo.get(sid)?.teamName ?? null;
          })
        : null;
      if (tasksServer) {
        console.log('[task-manager] mcpServers attached for session (team_name lazy-resolved)');
      }
      const q = query({
        prompt: userMessageIterable,
        options: {
          cwd: opts.cwd,
          model: opts.model,
          permissionMode: opts.permissionMode ?? 'default',
          // bypassPermissions 是 SDK 的"敏感档"，必须配套显式打开 allowDangerouslySkipPermissions
          // 否则 CLI 子进程会拒绝该模式（sdk.mjs 把它们当两个独立 CLI flag 传）。
          // 只在用户明确选了 bypassPermissions 时才开 —— 这样运行时 setPermissionMode 切到
          // 别的模式后，flag 不会留下残余权限放大风险（CLI 子进程已经按这个 flag 启动）。
          allowDangerouslySkipPermissions: opts.permissionMode === 'bypassPermissions',
          // Claude Code 默认 system prompt + agent-deck 自带 CLAUDE.md（追加到末尾）。
          // append 文本读自 resources/claude-config/CLAUDE.md，跟随应用打包；
          // 实际位置在 user/project/local 三层 CLAUDE.md 全部加载完之后，
          // LLM 上下文末尾位置 instruction following 最强。
          // 已去掉用户自定义 systemPrompt 功能（避免 isolation mode 与 agent-deck 约定冲突）。
          //
          // CHANGELOG_46 起 team 名由 lead 在会话内自由建（NewSessionDialog 删了 teamName
          // 输入框），spawn 时不需要在 systemPrompt 拼 per-session team 元信息——team-coordinator
          // 通过 PreToolUse hook / fs watcher / hook 三层反向同步即可。
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: getAgentDeckSystemPromptAppend(),
          },
          // agent-deck 自带 plugin：受 settings.injectAgentDeckPlugin 开关控制
          // （与 CLAUDE.md 注入开关同模式）。开 → skill 以 `agent-deck:<skill-name>`
          // 命名空间注册；关 → 返回空数组，会话只能用 user/project/local 范围 skill。
          // 与用户 ~/.claude/skills/ + project .claude/skills/ 都不冲突
          // （plugin 强制命名空间前缀）。
          plugins: getAgentDeckPluginsForSession(),
          // Task Manager（CHANGELOG_43）：开关开 → 挂 in-process MCP server `tasks` +
          // pre-approve `mcpServers__tasks__*`（任务工具属于受控应用工具，不走 canUseTool
          // 弹框）。teamName 已通过 closure 注入到 5 个 tool handler，agent 不能瞎传。
          // 开关关 → 不展开这两字段，与不挂 plugin 同语义零副作用。
          ...(tasksServer
            ? {
                mcpServers: { tasks: tasksServer },
                allowedTools: ['mcp__tasks__*'],
              }
            : {}),
          // 复用本地 Claude Code 配置（hooks / MCP / agents / permissions）
          settingSources: ['user', 'project', 'local'],
          canUseTool,
          // resume：传入历史 sessionId，SDK 会让 CLI 加载 ~/.claude/projects/<cwd>/<sid>.jsonl
          // 续上之前的对话，第一条 SDKMessage 的 session_id 就是这个 sid。
          resume: opts.resume,
          // SDK 默认 spawn 'node'，但 .app 走 launchd 启动时 PATH 不含 nvm/homebrew 的 node。
          // 用 Electron 二进制 + ELECTRON_RUN_AS_NODE=1 复用内置 Node runtime（详见 sdk-runtime.ts）。
          executable: runtime.executable,
          // REVIEW_12 Bug 5：注入 AGENT_DECK_ORIGIN=sdk env，CLI 子进程继承后由 hook curl
          // 命令转发为 X-Agent-Deck-Origin: sdk header；HookServer 据此把 event.hookOrigin
          // 标为 'sdk'。即便 OLD CLI 被 SIGTERM 后内部 fork 出新 sessionId + cwd=home dir
          // fallback 飞回迟到 hook event，仍带 hookOrigin='sdk'，ingest 入口能据此 skip
          // 不创建 source='cli' 孤儿 record。用户独立终端跑 `claude` 没有此 env，header
          // 走默认 'cli'，不受影响。
          //
          // Agent Teams（M1）：当 settings.agentTeamsEnabled=true 且 teamName 非空时，
          // 注入 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 启用 Claude Code 的 agent teams
          // 实验特性（lead 可 spawn teammates、共享 task list、3 个新 hook 事件）。
          // env 是 spawn 时一次性传入，关 toggle 不影响在跑会话；summarizer 走自己的
          // query() 调用、不读 teamName，env 也不传，天然不被污染。
          //
          // 即便用户在 ~/.claude/settings.json 手动写过 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0，
          // applyClaudeSettingsEnv 写进 process.env 后被 ES 展开覆盖语义保证 '1' 胜出。
          // CHANGELOG_46：env 注入只看 settings.agentTeamsEnabled，不再要求 opts.teamName 非空。
          // team 名由 lead 在会话内自由建（NewSessionDialog 已删 teamName 输入框），应用通过
          // team-coordinator 反向同步到 sessions.team_name。
          // env 是 spawn 时一次性传入，关 toggle 不影响在跑会话；summarizer 走自己的 query() 调用、
          // 不读 agentTeamsEnabled，env 也不传，天然不被污染。
          //
          // 即便用户在 ~/.claude/settings.json 手动写过 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0，
          // applyClaudeSettingsEnv 写进 process.env 后被 ES 展开覆盖语义保证 '1' 胜出。
          env: {
            ...runtime.env,
            AGENT_DECK_ORIGIN: 'sdk',
            ...(settingsStore.get('agentTeamsEnabled')
              ? { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }
              : {}),
          },
          // CHANGELOG_45 后续修复 v2（撤回 v1）：
          // v1 试过用 SDK extraArgs 把 teamName 通过 CLI `--team-name <name>` flag 传给 lead
          // CLI，**实测 CLI top-level help 没有 --team-name arg**（strings 里那个字符串属于
          // CLI 内部模块文档，不是启动 flag）→ CLI 启动直接 exit code 1，会话起不来。
          //
          // 撤回该改动。team 名传递改走 systemPrompt.append 注入（见下面 systemPrompt 字段），
          // 让 lead 在 system prompt 里"看到"自己属于哪个 team，spawn teammate 时自然用这个名字。
          // 不传 CLI flag 就不会触发 CLI 启动失败；唯一缺点是 lead 必须读到那一行才生效，
          // 但 SKILL.md 已明确要求 team_name 从会话上下文取，对齐良好。
          // SDK 0.2.x 把 cli.js 拆成 native binary（platform-specific 包），SDK 内部
          // require.resolve 拿到的路径在 .app 里走 `app.asar/...`，spawn 走系统 syscall
          // 不经 Electron fs patch → ENOTDIR → query 立刻死。显式传解析后的 unpacked 路径
          // 绕开 SDK 自带 K7。dev 模式下函数返回真实 node_modules 路径，无副作用。
          ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
          // OS 级沙盒（REVIEW_14 阶段 2）：根据 settings.claudeCodeSandbox 档位拼装
          // managedSettings.sandbox 字段（policy 层，user/project/local 不可放宽）。
          // 'off' 返回空对象，无 sandbox 字段，行为同现状（仅 canUseTool 弹框）。
          // 'workspace-write' / 'strict' 返回 { managedSettings: { sandbox: {...} } }。
          //
          // **summarizer 不被污染**：summarizer 走 `settingSources: []` + 自己 query() 调用，
          // 不读 sandbox 设置（与 agentTeamsEnabled 隔离同模式）。
          //
          // **双弹框 UX 收口**：sandbox 启用后 model 想联网会触发 SDK 内置的
          // `SandboxNetworkAccess` 工具 → canUseTool 顶部自动 deny + message → model
          // fallback `dangerouslyDisableSandbox: true` 重试 → canUseTool 弹给用户审批
          // （仅 1 次弹框）。strict 档因 `allowUnsandboxedCommands: false` 直接封死
          // 逃逸路径，model 报「无法联网」给用户。
          //
          // 用前面预算好的 sandboxOpts（避免重复 settingsStore.get + 让 console.log 与
          // 实际传给 SDK 的值一定一致，杜绝「log 说 enabled 但实际没传」的矛盾）。
          ...sandboxOpts,
        },
      });
      internal.query = q;
      this.sessions.set(tempKey, internal);

      // 等待第一条带 session_id 的 SDKMessage（system init 几乎一定会先到）
      // REVIEW_5 H4：把 opts.resume 传下去，30s fallback 时用 OLD_ID 作 sessionId
      // 替代 tempKey emit 占位事件，让 ingest 走 existing 分支不再创建第二条 active record
      realId = await this.waitForRealSessionId(internal, tempKey, opts.resume);

      // 注册到 SessionManager 的 sdk-owned 集合，后续 hook 回环将被去重
      sessionManager.claimAsSdk(realId);
    } catch (err) {
      // 任何中间步骤抛错：回滚 sessions / 释放 pending，再 throw 给上层 IPC 显错
      this.sessions.delete(tempKey);
      releasePending();
      // REVIEW_5 H4：构造期就 claim 了 opts.resume，失败路径必须释放，
      // 否则下次同 sessionId 的真实 hook / 终端 CLI 会话会被静默吞掉
      if (opts.resume) sessionManager.releaseSdkClaim(opts.resume);
      throw err;
    }
    // 真实 id 已经入手，cwd 待领取标记可以释放（如果 hook 已经先消费过则是 no-op）
    releasePending();

    // 主动发一条 session-start，让 UI 能立刻看到这个会话
    this.opts.emit({
      sessionId: realId,
      agentId: AGENT_ID,
      kind: 'session-start',
      payload: { cwd: opts.cwd, source: 'sdk' },
      ts: Date.now(),
      source: 'sdk',
    });

    // createSession 的首条 prompt 没有走 sendMessage（直接塞进 pendingUserMessages 给 SDK），
    // 所以这里补 emit 一条 user message event，让活动流看到「你」发的第一条话
    // —— 跟新建会话和恢复会话两条路径都适用。
    if (opts.prompt) {
      this.opts.emit({
        sessionId: realId,
        agentId: AGENT_ID,
        kind: 'message',
        payload: { text: opts.prompt, role: 'user' },
        ts: Date.now(),
        source: 'sdk',
      });
    }

    return {
      sessionId: realId,
      abort: () => void this.interrupt(realId),
    };
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      // 通道死了（dev 重启 / SDK 流自然终止 / 历史会话 lifecycle 已 dormant 或 closed 等）。
      // 早期靠 throw 'not found' 让 renderer 自己识别再调 createAdapterSession({resume:...})；
      // CHANGELOG_26 / B 方案：把恢复语义沉到 adapter owner 层，renderer 不感知 resume 实现细节。
      // 委托 recoverAndSend：单飞 + 完整复用 createSession（H4/H1 全套护栏不绕）。
      // 失败仍 throw 给 IPC，与原 'not found' 路径行为一致。
      await this.recoverAndSend(sessionId, text);
      return;
    }

    // 单条字节上限：Buffer.byteLength 用 utf8 计算真实字节数（中文 3 字节 / 字符）。
    // 超过就拒绝，让 IPC handler 把错误抛给 renderer，UI 显示红条提示用户精简或拆分。
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_MESSAGE_BYTES) {
      throw new Error(
        `单条消息 ${(bytes / 1000).toFixed(1)}KB 超过 ${MAX_MESSAGE_BYTES / 1000}KB 上限。请精简或拆分发送。`,
      );
    }

    // 队列上限：超过就拒绝排队，让 UI 给用户明确反馈。
    if (s.pendingUserMessages.length >= MAX_PENDING_MESSAGES) {
      throw new Error(
        `待发送队列已堆积 ${MAX_PENDING_MESSAGES} 条。请先处理 pending 请求（权限/提问/计划批准）` +
          `或等 Claude 消费当前队列再继续发送。`,
      );
    }

    // 提示：还有未响应的权限/提问/计划批准时，SDK query() 正卡在 await canUseTool 的 Promise，
    // 用户的新消息会进 pendingUserMessages 队列但 Claude 短时间内不会处理它。
    // 在活动流插一条警告 message，避免用户以为 Claude 死了。
    const pendCount =
      s.pendingPermissions.size + s.pendingAskUserQuestions.size + s.pendingExitPlanModes.size;
    if (pendCount > 0) {
      this.opts.emit({
        sessionId,
        agentId: AGENT_ID,
        kind: 'message',
        payload: {
          text:
            `⚠ 还有 ${pendCount} 个待你处理的请求（权限/提问/计划批准）。` +
            `你这条消息会被排队，但 Claude 要等你先处理完上面的请求才会看到它。`,
          error: true,
        },
        ts: Date.now(),
        source: 'sdk',
      });
    }

    s.pendingUserMessages.push(this.makeUserMessage(sessionId, text));
    s.notify?.();
    // 把用户输入也作为一条 message event emit 出去，详情面板能看到完整对话；
    // role: 'user' 让 UI 区分用户/Claude
    this.opts.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: { text, role: 'user' },
      ts: Date.now(),
      source: 'sdk',
    });
  }

  /**
   * 断连自愈：sendMessage 检测到 sessions Map 没有这个 sessionId 时走这里。
   *
   * 设计要点（B 方案 / CHANGELOG_26，双对抗 Agent 都强调的硬约束）：
   *
   * 1. **单飞**：同 sessionId 并发等同一个 inflight Promise，避免：
   *    - 并发 N 条 sendMessage → 起 N 个 SDK CLI 子进程 + Anthropic 按次计费
   *    - createSession 内 `claimAsSdk(opts.resume)` 被同 sessionId 多次重入造成 sdkOwned 状态错乱
   *    - CHANGELOG_24 备注里挂的「用户连点恢复多次起多个 SDK query」边界由本方法收敛
   *
   * 2. **完整复用 createSession**：禁止在这里自拼 emit/upsert/rename，必须让
   *    `expectSdkSession(cwd) → claimAsSdk(opts.resume) → dedupOrClaim B 分支兜底
   *    → waitForRealSessionId(_, _, opts.resume)` 全套 REVIEW_5 H4/H1 护栏按原样跑，
   *    任何捷径都会重打开「两条 active record」bug。
   *
   * 3. **用户消息只 emit 一次**：createSession 内部已 emit `kind:'message', role:'user'`
   *    这条触发恢复的 prompt，本方法不再重复 emit；后续 inflight 等待者走完整 sendMessage
   *    第二段把它们的 text 正常 push + emit。
   *
   * 4. **占位 message**：进入恢复立刻 emit「⚠ SDK 通道已断开，正在自动恢复…」非 error
   *    占位，让 UI 在 30s fallback 期间不至于哑巴 busy；恢复成功后正常 message 流自然续；
   *    失败由 catch emit 一条「⚠ 自动恢复失败」error message。
   *
   * 5. **从 sessionRepo 补回 cwd / permissionMode**：
   *    - cwd 必填（resume 路径仍要 expectSdkSession(cwd)）
   *    - permissionMode 用户上次主动选过的值，不能默认 'default' 否则用户辛苦切到的
   *      plan / acceptEdits 被静默还原
   *    - 历史 record 完全不存在时直接抛与原行为一致的 'not found'，让 IPC 把错原样透传 renderer
   */
  private async recoverAndSend(sessionId: string, text: string): Promise<void> {
    const inflight = this.recovering.get(sessionId);
    if (inflight) {
      // 等同一恢复完成 → 然后正常走完整 sendMessage 流程把这条新 text push 进 sessions。
      // catch 静默：第一波恢复失败时第二条等待者自己再走 sendMessage，要么进新一轮 recovery，
      // 要么拿到真错。不要把第一波的错往第二条上抛 —— 调用方只关心自己这条的成败。
      try {
        await inflight;
      } catch {
        // 第一波恢复已失败，第二条自己再撞一次
      }
      return this.sendMessage(sessionId, text);
    }

    const rec = sessionRepo.get(sessionId);
    if (!rec) {
      // 没有历史 record：彻底无法恢复，保留原 throw 信号兼容上层处理
      throw new Error(`session ${sessionId} not found`);
    }

    // CHANGELOG_31：用户在 detail 里主动发消息触发 recoverAndSend = 显式表达「我又要聊它了」，
    // 自动取消归档。manager.ts:118-121 立的「归档与 lifecycle 正交，不能因事件流自动 unarchive」
    // 约束针对的是 hook 触发的事件流（避免外部 CLI 在同 cwd 跑导致用户刚归档的会话被自动恢复），
    // 本路径是用户显式 UI 动作不冲突。不 unarchive 的话，jsonl 在 + 不 fork 路径（realId === OLD_ID）
    // 下 OLD_ID record 不动，archived_at 还在 → listHistory 仍返回这条 → 用户体感「我都在跟它聊了
    // 但它还在历史列表里」与 CLAUDE.md「凡让用户感觉像新开会话 / 跳回列表都是 bug」总纲冲突。
    // unarchive 内部 emit session-upserted，HistoryPanel 监听后自动 reload 把这条从历史列表移除。
    if (rec.archivedAt !== null) {
      console.warn(
        `[sdk-bridge] recoverAndSend on archived session ${sessionId}, auto-unarchiving (user explicitly sending message)`,
      );
      sessionManager.unarchive(sessionId);
    }

    // 字节上限：恢复路径不能绕过此防线（防超长 prompt 当作恢复路径首条消息送进 createSession）
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_MESSAGE_BYTES) {
      throw new Error(
        `单条消息 ${(bytes / 1000).toFixed(1)}KB 超过 ${MAX_MESSAGE_BYTES / 1000}KB 上限。请精简或拆分发送。`,
      );
    }

    // 占位 message：30s fallback 期间用户至少看到「在恢复」而不是哑巴 busy。
    // 不打 error: true（不是错误，是状态提示）；resume 成功后正常 message 流接续，
    // 占位 message 留在活动流上一行轻量「断开过」痕迹，对回看 / 调试反而有用。
    //
    // REVIEW_17 R3 / M3-R3：5s dedup 窗口防同 sessionId 短时间内反复 recover 重 emit
    // 多条「⚠ SDK 通道已断开」噪声（场景：首次 recover 失败 swallow + 再次 sendMessage
    // 又进 recoverAndSend，inflight 已删，第二条进来无条件 emit，用户在 detail 看到
    // 多条同款占位）。
    const lastPlaceholderAt = this.placeholderEmittedAt.get(sessionId);
    const nowTs = Date.now();
    if (lastPlaceholderAt === undefined || nowTs - lastPlaceholderAt > PLACEHOLDER_DEDUP_MS) {
      this.placeholderEmittedAt.set(sessionId, nowTs);
      // 顺手清掉过期 entry（避免 Map 无限涨）
      for (const [k, ts] of this.placeholderEmittedAt) {
        if (nowTs - ts > PLACEHOLDER_DEDUP_MS) this.placeholderEmittedAt.delete(k);
      }
      this.opts.emit({
        sessionId,
        agentId: AGENT_ID,
        kind: 'message',
        payload: { text: '⚠ SDK 通道已断开，正在自动恢复…' },
        ts: nowTs,
        source: 'sdk',
      });
    }

    const p = (async () => {
      try {
        // CHANGELOG_28：预检 jsonl 是否存在 —— CLI 在 resume 时若找不到
        // ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl 会 hard fail 抛
        // "No conversation found with session ID: <sid>"，consume 内 catch 吞错只 emit
        // 一条「⚠ SDK 流中断」error message + finally emit session-end，createSession 本身
        // 不抛错（waitForRealSessionId 拿不到 first session_id 走 30s fallback 用 tempKey 兜底
        // → 注册一个无实际 SDK 状态的占位 session）。这种场景对用户表现：detail 卡在
        // 「⚠ SDK 通道已断开」+ 「⚠ SDK 流中断」+ 「会话结束」三条红字之间，再发还是同样错。
        //
        // 触发条件：jsonl 被 CLI 自身清理 / 用户手动删过 / 跨设备同步未带 jsonl 等。预检比
        // try/catch 后 fallback 更可靠（不依赖 SDK 错误字符串匹配，正是 P12 教训）。
        // 不存在时直接走不带 resume 的新建路径，事后手工 rename OLD_ID → newRealId 把
        // 应用层 events / file_changes / summaries 子表迁过去（CLI jsonl 历史失，但应用层 DB
        // 历史保留 + sessionId 切换链路与 fork detection 路径一致）。
        if (!this.resumeJsonlExists(rec.cwd, sessionId)) {
          console.warn(
            `[sdk-bridge] resume jsonl missing for ${sessionId} @ ${rec.cwd}, ` +
              `falling back to new CLI session (CLI history lost but app DB preserved)`,
          );
          // REVIEW_7 H1：直接用 createSession 返回值拿 newRealId，不再 entries() 反查 cwd。
          // 旧版用 `for ... entries() if cwd === rec.cwd break` 取 first 推断「最新创建的」，
          // 但 Map 迭代是插入顺序——同 cwd 已存在别的 SDK 会话时会先取到那条历史 session_id，
          // 把 OLD_ID 的 events/file_changes/summaries 子表错迁到不相关会话上。
          const handle = await this.createSession({
            cwd: rec.cwd,
            prompt: text,
            permissionMode: rec.permissionMode ?? undefined,
          });
          const newRealId = handle.sessionId;
          if (newRealId !== sessionId) {
            console.warn(
              `[sdk-bridge] post-fallback rename ${sessionId} → ${newRealId} ` +
                `(carry app-side events/file_changes/summaries history)`,
            );
            // REVIEW_7 M1+M3：renameSdkSession 内聚 claim 转移（M3）；包 try/catch 透传错误（M1）。
            // sessionRepo.rename 内事务保证数据原子（要么全迁要么不动），rename 抛错时 OLD claim
            // 没动（M3 后 sdkOwned 转移在 rename 后；rename 抛在 sdkOwned 操作前）。
            // 不 throw —— NEW_ID 通道已建立，rename 只是 best-effort history carry，
            // throw 会让用户的 sendMessage 失败，影响主路径。
            try {
              sessionManager.renameSdkSession(sessionId, newRealId);
            } catch (renameErr) {
              console.error(
                `[sdk-bridge] post-fallback rename failed ${sessionId} → ${newRealId}, ` +
                  `NEW_ID session still works but app-side history not migrated.`,
                renameErr,
              );
            }
          }
          return;
        }

        await this.createSession({
          cwd: rec.cwd,
          prompt: text,
          resume: sessionId,
          // permissionMode null = 用户没主动选过，按 createSession 内默认 'default'；
          // 已选过的（acceptEdits / plan / bypassPermissions）必须复原，否则用户体感
          // 「我设过的权限模式被悄悄重置」
          permissionMode: rec.permissionMode ?? undefined,
        });
      } finally {
        this.recovering.delete(sessionId);
      }
    })();
    this.recovering.set(sessionId, p);

    try {
      await p;
    } catch (err) {
      // createSession 失败：占位 message 已经 emit，再补一条 error message 让用户看到原因
      this.opts.emit({
        sessionId,
        agentId: AGENT_ID,
        kind: 'message',
        payload: {
          text: `⚠ 自动恢复失败：${(err as Error)?.message ?? String(err)}`,
          error: true,
        },
        ts: Date.now(),
        source: 'sdk',
      });
      throw err;
    }
  }

  /**
   * 预检 CLI resume 用的 jsonl 文件是否存在。
   *
   * Claude Code CLI 把会话历史落在 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`，
   * encoded-cwd 规则：把绝对路径的 `/` 全替换为 `-`，顶部前缀也是 `-`（实测 macOS：
   * `/Users/apple/Repository/personal/agent-deck` → `-Users-apple-Repository-personal-agent-deck`）。
   *
   * 不存在时 CLI `--resume <sid>` 会 hard fail 抛 "No conversation found"，必须走不带
   * resume 的新建路径（CHANGELOG_28）。这条规则跨 OS 是否一致存疑（Linux 同样规则，
   * Windows 未验证），如果 CLI 内部规则未来改了，预检会假阴性 → 退化到原 try-and-fail 行为。
   *
   * protected 而非 private：测试里子类 override 让单测不依赖真 ~/.claude/projects 目录
   */
  protected resumeJsonlExists(cwd: string, sessionId: string): boolean {
    try {
      const encodedDir = '-' + cwd.split('/').filter(Boolean).join('-');
      const jsonlPath = `${homedir()}/.claude/projects/${encodedDir}/${sessionId}.jsonl`;
      return existsSync(jsonlPath);
    } catch {
      // 任意异常（cwd 解析失败 / FS 权限）→ 退化让 createSession 自己 try，最差不过原行为
      return true;
    }
  }

  /**
   * 用户对一次工具调用的允许/拒绝。如果会话不存在或 requestId 已被处理，静默忽略。
   */
  respondPermission(sessionId: string, requestId: string, response: PermissionResponse): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const entry = s.pendingPermissions.get(requestId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    s.pendingPermissions.delete(requestId);
    if (response.decision === 'allow') {
      entry.resolver({
        behavior: 'allow',
        updatedInput: (response.updatedInput ?? {}) as Record<string, unknown>,
        updatedPermissions: response.updatedPermissions as PermissionResult extends {
          updatedPermissions?: infer U;
        }
          ? U
          : never,
      });
    } else {
      entry.resolver({
        behavior: 'deny',
        message: response.message ?? '用户拒绝',
        interrupt: false,
      });
    }
  }

  /** 用户提交 AskUserQuestion 的答案，把它喂回给 SDK。 */
  respondAskUserQuestion(sessionId: string, requestId: string, answer: AskUserQuestionAnswer): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const entry = s.pendingAskUserQuestions.get(requestId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    s.pendingAskUserQuestions.delete(requestId);
    entry.resolver(answer);
  }

  /**
   * 用户对 ExitPlanMode 的决策（批准 / 继续规划），驱动 SDK allow / deny。
   *
   * 4 档目标 mode 分两类处理：
   * - approve + targetMode ∈ {default, acceptEdits, plan}：热切。resolver 走 allow，settle 后
   *   同步调 `query.setPermissionMode(targetMode)` + 写 DB + emit upsert，下次工具调用按新 mode。
   * - approve-bypass：冷切。resolver 走 deny + interrupt:true 中止 OLD turn，外层调
   *   `restartWithPermissionMode` 把 plan 文本作 handoff prompt 重启 SDK 子进程到 bypass，
   *   规避「allow 后 SDK 推 tool_use 与重启子进程抢 jsonl flush」race。
   * - keep-planning：deny + 用户反馈，Claude 留在 plan mode 修计划。
   */
  async respondExitPlanMode(
    sessionId: string,
    requestId: string,
    response: ExitPlanModeResponse,
  ): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const entry = s.pendingExitPlanModes.get(requestId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    s.pendingExitPlanModes.delete(requestId);
    // 冷切档先打 expectedClose：resolver 即将返回 deny+interrupt:true 让 SDK 强制中止
    // OLD turn，会触发 SDK 内部 [ede_diagnostic] 状态机不一致诊断错误（result_type=user
    // + stop_reason=tool_use 不匹配）。flag 让 consume() catch 块认出这是设计内的副产品，
    // 不弹「⚠ SDK 流中断」红字 message。后续 restartWithPermissionMode → closeSession
    // 还会再打一次（双保险，覆盖所有应用主动关闭的入口）。
    if (response.decision === 'approve-bypass') {
      s.expectedClose = true;
    }
    // 先驱动 SDK：approve→allow / approve-bypass→deny+interrupt / keep-planning→deny
    entry.resolver(response);

    if (response.decision === 'approve') {
      // REVIEW_11 Bug 3：approve+plan 走 deny+message 让 CLI 留在 plan，绝不能再调
      // setPermissionMode('plan')（CLI 当前已经在 plan，调了等于 no-op；更危险的是
      // 走 setPermissionMode 路径会触发 SDK 内部 mode 重置 race，反而把档抖回 default）。
      // 仅 approve + targetMode ∈ {default, acceptEdits} 才走热切；plan 分支不动 SDK 也不写 DB
      // （DB 已是 plan，SDK 也仍在 plan）。
      if (response.targetMode === 'plan') {
        return;
      }
      // 热切档：SDK 已退出 plan mode，立刻同步 mode 到 SDK Query + DB + UI
      try {
        await s.query.setPermissionMode(response.targetMode);
        sessionRepo.setPermissionMode(sessionId, response.targetMode);
        const updated = sessionRepo.get(sessionId);
        if (updated) eventBus.emit('session-upserted', updated);
      } catch (err) {
        console.warn(
          `[sdk-bridge] hot-switch permission mode after approve failed: ${sessionId}`,
          err,
        );
      }
      return;
    }

    if (response.decision === 'approve-bypass') {
      // 冷切档：resolver 已 deny + interrupt OLD turn；现在重启子进程到 bypass，
      // 把 plan 文本作 handoff 让 Claude 重新执行（无需再调 ExitPlanMode）
      const handoffPrompt =
        `用户已批准以下 plan 并切换到完全免询问模式（bypassPermissions），` +
        `请直接按 plan 执行（无需再次调用 ExitPlanMode 确认）：\n\n` +
        entry.payload.plan;
      try {
        await this.restartWithPermissionMode(sessionId, 'bypassPermissions', handoffPrompt);
      } catch (err) {
        // restartWithPermissionMode 内部已 emit error message + 回滚 DB，这里只 log
        console.error(
          `[sdk-bridge] cold-switch to bypass after approve failed: ${sessionId}`,
          err,
        );
      }
    }
    // keep-planning：什么都不用做，resolver 已 deny + Claude 留在 plan mode
  }

  /**
   * 当前会话还在 pending 的请求快照。renderer HMR / 重启 / 切会话时，
   * store 的 pendingPermissionsBySession 是空的，但主进程这边可能还挂着等用户的请求 ——
   * 让 renderer 主动拉一次重建 UI，避免渲染成「已处理」按钮不显示、用户点不动死锁。
   */
  listPending(sessionId: string): {
    permissions: PermissionRequest[];
    askQuestions: AskUserQuestionRequest[];
    exitPlanModes: ExitPlanModeRequest[];
  } {
    const s = this.sessions.get(sessionId);
    if (!s) return { permissions: [], askQuestions: [], exitPlanModes: [] };
    return {
      permissions: [...s.pendingPermissions.values()].map((e) => e.payload),
      askQuestions: [...s.pendingAskUserQuestions.values()].map((e) => e.payload),
      exitPlanModes: [...s.pendingExitPlanModes.values()].map((e) => e.payload),
    };
  }

  /** 全量快照：renderer 启动时一次性灌进 store。 */
  listAllPending(): Record<string, {
    permissions: PermissionRequest[];
    askQuestions: AskUserQuestionRequest[];
    exitPlanModes: ExitPlanModeRequest[];
  }> {
    const out: Record<
      string,
      {
        permissions: PermissionRequest[];
        askQuestions: AskUserQuestionRequest[];
        exitPlanModes: ExitPlanModeRequest[];
      }
    > = {};
    for (const [sid, s] of this.sessions) {
      if (
        s.pendingPermissions.size === 0 &&
        s.pendingAskUserQuestions.size === 0 &&
        s.pendingExitPlanModes.size === 0
      ) {
        continue;
      }
      out[sid] = {
        permissions: [...s.pendingPermissions.values()].map((e) => e.payload),
        askQuestions: [...s.pendingAskUserQuestions.values()].map((e) => e.payload),
        exitPlanModes: [...s.pendingExitPlanModes.values()].map((e) => e.payload),
      };
    }
    return out;
  }

  /** 超时触发：把权限请求当成 deny+interrupt 处理，等同于用户拒绝并打断当前 turn。 */
  private timeoutPermission(sessionId: string, requestId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const entry = s.pendingPermissions.get(requestId);
    if (!entry) return;
    s.pendingPermissions.delete(requestId);
    // 不需要 clearTimeout：本次回调就是这个 timer 触发的
    this.opts.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'waiting-for-user',
      payload: { type: 'permission-cancelled', requestId },
      ts: Date.now(),
      source: 'sdk',
    });
    this.opts.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: {
        text:
          `⚠ 权限请求 ${entry.payload.toolName ?? ''} 等待 ${Math.round(this.permissionTimeoutMs / 1000)} 秒未响应，` +
          `已自动按「拒绝」处理并中断当前 turn。`,
        error: true,
      },
      ts: Date.now(),
      source: 'sdk',
    });
    entry.resolver({ behavior: 'deny', message: 'timeout', interrupt: true });
  }

  /** 超时触发：AskUserQuestion 与权限请求处理类似，但 interrupt:false 让 SDK 把它当成空答案。 */
  private timeoutAskUserQuestion(sessionId: string, requestId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const entry = s.pendingAskUserQuestions.get(requestId);
    if (!entry) return;
    s.pendingAskUserQuestions.delete(requestId);
    this.opts.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'waiting-for-user',
      payload: { type: 'ask-question-cancelled', requestId },
      ts: Date.now(),
      source: 'sdk',
    });
    this.opts.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: {
        text:
          `⚠ Claude 的提问等待 ${Math.round(this.permissionTimeoutMs / 1000)} 秒未答复，已自动跳过。`,
        error: true,
      },
      ts: Date.now(),
      source: 'sdk',
    });
    entry.resolver({
      answers: [{ question: '__timeout__', selected: [], other: '用户超时未回答' }],
    });
  }

  /** 超时触发：ExitPlanMode 按「继续规划 + 默认反馈」处理，让 Claude 留在 plan mode 不打断 turn。 */
  private timeoutExitPlanMode(sessionId: string, requestId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const entry = s.pendingExitPlanModes.get(requestId);
    if (!entry) return;
    s.pendingExitPlanModes.delete(requestId);
    this.opts.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'waiting-for-user',
      payload: { type: 'exit-plan-cancelled', requestId },
      ts: Date.now(),
      source: 'sdk',
    });
    this.opts.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: {
        text:
          `⚠ ExitPlanMode 等待 ${Math.round(this.permissionTimeoutMs / 1000)} 秒未响应，` +
          `已自动按「继续规划」处理，Claude 留在 plan mode 等待下一步指示。`,
        error: true,
      },
      ts: Date.now(),
      source: 'sdk',
    });
    entry.resolver({ decision: 'keep-planning', feedback: '用户超时未响应' });
  }

  async interrupt(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    try {
      await s.query.interrupt();
    } catch (err) {
      console.warn(`[sdk-bridge] interrupt failed`, err);
    }
  }

  /**
   * 删会话清理：abort live query + 兜底清 pending timer + 移除 internal session 记录。
   * 与 interrupt 区别：interrupt 允许 resume / 继续同 session；close 是永久关闭，
   * 由 SessionManager.delete 调用，确保 SDK 子进程不继续跑（CHANGELOG_20 / N2）。
   */
  async closeSession(sessionId: string): Promise<void> {
    let key: string | null = null;
    let internal: InternalSession | null = null;
    for (const [k, v] of this.sessions.entries()) {
      if (k === sessionId || v.realSessionId === sessionId) {
        key = k;
        internal = v;
        break;
      }
    }
    if (!internal || !key) return;

    // 1. abort query —— SDK 通过 ctx.signal 通知 canUseTool 链路，
    //    pending Maps 内每条 entry 自身的 abort handler 会被触发并 resolver 释放，
    //    consume() finally 也会清掉残余 pending。这里只是触发起点。
    //
    // 先打 expectedClose：interrupt 会让 SDK query loop 抛错（典型 [ede_diagnostic]
    // / AbortError 等），catch 块据此降为 console.warn 不 emit「⚠ SDK 流中断」红字
    // message——应用层主动关闭的副产品不该污染 UI 时间线。覆盖所有 closeSession 入口
    // （SessionManager.delete / restartWithPermissionMode 冷切 / 应用退出清理等）。
    internal.expectedClose = true;
    try {
      await internal.query?.interrupt?.();
    } catch (err) {
      console.warn(`[sdk-bridge] interrupt during close failed: ${sessionId}`, err);
    }

    // 2. 兜底清 pending timer：abort 信号 propagate 不一定立即触发所有 entry handler，
    //    timer 残留 30s+ 会让进程持有 callback 引用。clear Map 也避免延迟 resolver 收到时
    //    Map 已空再 set 出错。
    //
    // 顺手修：清 Map **之前** emit `*-cancelled` 事件给 renderer，否则 store 端 zombie row
    // 残留（用户点了 silently no-op）。冷切场景（restartWithPermissionMode）会高频触发
    // closeSession，没这步就会大量泄漏 zombie row。
    const realIdForEmit = internal.realSessionId ?? sessionId;
    for (const entry of internal.pendingPermissions.values()) {
      this.opts.emit({
        sessionId: realIdForEmit,
        agentId: AGENT_ID,
        kind: 'waiting-for-user',
        payload: { type: 'permission-cancelled', requestId: entry.payload.requestId },
        ts: Date.now(),
        source: 'sdk',
      });
      if (entry.timer) clearTimeout(entry.timer);
    }
    internal.pendingPermissions.clear();
    for (const entry of internal.pendingAskUserQuestions.values()) {
      this.opts.emit({
        sessionId: realIdForEmit,
        agentId: AGENT_ID,
        kind: 'waiting-for-user',
        payload: { type: 'ask-question-cancelled', requestId: entry.payload.requestId },
        ts: Date.now(),
        source: 'sdk',
      });
      if (entry.timer) clearTimeout(entry.timer);
    }
    internal.pendingAskUserQuestions.clear();
    for (const entry of internal.pendingExitPlanModes.values()) {
      this.opts.emit({
        sessionId: realIdForEmit,
        agentId: AGENT_ID,
        kind: 'waiting-for-user',
        payload: { type: 'exit-plan-cancelled', requestId: entry.payload.requestId },
        ts: Date.now(),
        source: 'sdk',
      });
      if (entry.timer) clearTimeout(entry.timer);
    }
    internal.pendingExitPlanModes.clear();

    // 3. 从 sessions map 移除：consume() 内 createUserMessageStream 检查 sessions.has(key) 决定是否 return，
    //    delete 之后 stream 在下一次 notify 后自然终止。
    this.sessions.delete(key);

    // 4. 释放 sdkOwned：避免后续同 sessionId 的 hook 事件被误吞（删了应该当作"不再接管"）。
    sessionManager.releaseSdkClaim(sessionId);
    if (internal.realSessionId && internal.realSessionId !== sessionId) {
      sessionManager.releaseSdkClaim(internal.realSessionId);
    }

    // REVIEW_12 Bug 5 双保险（origin tag 是主修法，本步是兜底）：把 sessionId 与
    // realSessionId 加进 recentlyDeleted 60s 黑名单——覆盖「OLD CLI 子进程被 SIGTERM 后
    // 飞回的迟到 hook event 仍带 OLD_ID 或 realSessionId」窗口。与 SessionManager.delete +
    // renameSdkSession 入口对称。即便 origin tag 在升级前的老 hook 命令路径下未携带
    // （hookOrigin === undefined → 按 'cli' 兼容），sessionId 黑名单也能挡住一部分孤儿。
    sessionManager.markRecentlyDeleted(sessionId);
    if (internal.realSessionId && internal.realSessionId !== sessionId) {
      sessionManager.markRecentlyDeleted(internal.realSessionId);
    }

    // 唤醒 createUserMessageStream 的 await，让它走到 sessions.has(key) === false 后 return。
    if (internal.notify) {
      const n = internal.notify;
      internal.notify = null;
      try {
        n();
      } catch {
        // ignore
      }
    }
  }

  /** 运行时切换权限模式。SDK 会从下一次工具调用起按新模式判断。 */
  async setPermissionMode(
    sessionId: string,
    mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions',
  ): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`session ${sessionId} not found`);
    await s.query.setPermissionMode(mode);
  }

  /**
   * 冷切：销毁旧 SDK 子进程，用新 mode 重建（复用 createSession 的 H4/H1 全套护栏）。
   *
   * 为什么不能用 setPermissionMode 热切？
   * - bypassPermissions 真正的开关是 createSession 时的 `allowDangerouslySkipPermissions: true` flag，
   *   CLI 子进程**初启时**按此 flag 锁死，运行时调 query.setPermissionMode('bypassPermissions')
   *   会被 SDK 静默吞，用户体感「切了但还在询问」。
   *
   * 为什么 handoffPrompt 必须非空？
   * - createSession 入口校验 prompt.trim() 非空（streaming 协议必须有首条 user message 才能启 CLI）。
   * - 调用方负责拼好语义（例如「用户已批准 plan…请直接执行」/「继续之前的会话」）。
   *
   * 单飞：与 sendMessage 触发的 recoverAndSend 共用 `this.recovering` Map，
   * 同 sessionId 的并发 cold-restart / connection-loss recovery 排队执行。
   *
   * 失败：snapshot oldMode → DB 已先翻新 mode → createSession fail 时回滚 DB +
   * emit error message 让 UI 下拉回弹。**不**重新 emit 已 settle 的 ExitPlanMode entry
   * （resolver 已 deny+interrupt 过一次，re-emit 假 row 用户点了 silently no-op）。
   *
   * @returns 重启后的真实 sessionId（CLI 隐式 fork 时会变；rename 后 OLD/NEW 都指向同条 DB record）
   */
  async restartWithPermissionMode(
    sessionId: string,
    mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions',
    handoffPrompt: string,
  ): Promise<string> {
    if (!handoffPrompt.trim()) {
      throw new Error('restartWithPermissionMode 要求 handoffPrompt 非空（SDK streaming 协议约束）');
    }

    // 单飞：等同 sessionId 的 in-flight recovery / restart 完成
    const inflight = this.recovering.get(sessionId);
    if (inflight) {
      try {
        await inflight;
      } catch {
        // 上一个 recovery 失败不影响本次重启尝试
      }
    }

    const rec = sessionRepo.get(sessionId);
    if (!rec) throw new Error(`session ${sessionId} not found in repo`);
    const oldMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' =
      rec.permissionMode ?? 'default';

    // 占位 message：分方向文案，让用户在 5-10s busy 期间看到状态
    const enterBypass = mode === 'bypassPermissions';
    const placeholderText = enterBypass
      ? '⚠ 正在切换到完全免询问模式（bypass），重启 SDK 中…'
      : `⚠ 正在切换权限模式到 ${mode}，重启 SDK 中…`;
    this.opts.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: { text: placeholderText },
      ts: Date.now(),
      source: 'sdk',
    });

    // close OLD：内部已修为 emit *-cancelled 事件清 renderer zombie row 后再清 Map
    await this.closeSession(sessionId);

    // 写 DB：必须先于 createSession（cold path 翻序；hot path 不动保持 ipc.ts:451-462 原样）。
    // 同步 emit upsert 让 SessionDetail 下拉值立即跟到新 mode（5-10s busy 期间用户已经看到「切完了」）。
    sessionRepo.setPermissionMode(sessionId, mode);
    const updatedRec = sessionRepo.get(sessionId);
    if (updatedRec) eventBus.emit('session-upserted', updatedRec);

    const p = (async (): Promise<string> => {
      try {
        const handle = await this.createSession({
          cwd: rec.cwd,
          prompt: handoffPrompt,
          resume: sessionId,
          permissionMode: mode,
        });
        const newRealId = handle.sessionId;
        // CLI 隐式 fork：拿到的 newRealId 可能 ≠ OLD sessionId（CLI 在 streaming + resume 下行为不可控，
        // 见 CLAUDE.md「会话恢复 / 断连 UX」节）。rename 把 DB 子表 + sdkOwned 整体迁到 NEW 名下。
        if (newRealId !== sessionId) {
          try {
            sessionManager.renameSdkSession(sessionId, newRealId);
          } catch (renameErr) {
            console.error(
              `[sdk-bridge] post-restart rename failed ${sessionId} → ${newRealId}, ` +
                `NEW session works but app-side history not migrated.`,
              renameErr,
            );
          }
        }
        return newRealId;
      } catch (err) {
        // 回滚：DB 改回 oldMode + emit upsert 让下拉回弹
        sessionRepo.setPermissionMode(sessionId, oldMode);
        const rolled = sessionRepo.get(sessionId);
        if (rolled) eventBus.emit('session-upserted', rolled);
        // 占位 message 已 emit 过，再 emit 一条 error 让用户知道失败 + 已回退
        this.opts.emit({
          sessionId,
          agentId: AGENT_ID,
          kind: 'message',
          payload: {
            text:
              `⚠ 切到 ${mode} 失败：${(err as Error)?.message ?? String(err)}。` +
              `权限模式已回退到 ${oldMode}，请重新发送一条消息让 Claude 续上 plan。`,
            error: true,
          },
          ts: Date.now(),
          source: 'sdk',
        });
        throw err;
      }
    })();
    this.recovering.set(sessionId, p);
    try {
      return await p;
    } finally {
      this.recovering.delete(sessionId);
    }
  }

  private makeUserMessage(sessionId: string, text: string): SDKUserMessage {
    return {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
  }

  private async *createUserMessageStream(
    internal: InternalSession,
    tempKey: string,
  ): AsyncIterable<SDKUserMessage> {
    while (true) {
      while (internal.pendingUserMessages.length > 0) {
        const msg = internal.pendingUserMessages.shift()!;
        yield msg;
      }
      await new Promise<void>((resolve) => {
        internal.notify = resolve;
      });
      internal.notify = null;
      const key = internal.realSessionId ?? tempKey;
      if (!this.sessions.has(key)) return;
    }
  }

  /**
   * 启动一个并行任务，从 query 流中读出第一条带 session_id 的消息，
   * 并切换 sessions Map 的 key 为真实 session_id。同时把消息流的「消费」
   * 交给 consume() 持续运行。
   *
   * 30 秒兜底：极端情况下 SDK 一直没回任何消息（CLI 鉴权失败 / 代理超限 / stream 卡死等），
   * 用 tempKey 顶上，并主动发一条错误消息让 UI 立刻看到「SDK 启动异常」，
   * 而不是悄无声息地坐等。后续真实 id 到达时 consume() 内部会自动修正 sdkOwned 集合。
   *
   * REVIEW_5 H4：resumeId 存在时 fallback 用它作 sessionId emit 错误消息，
   * 让 ingest 走 existing 分支不再造 tempKey 占位 active record（与 hook 抢先复活的
   * OLD_ID 形成两条 active 同时显示的 bug 已修，详见 createSession 注释）。
   */
  private waitForRealSessionId(
    internal: InternalSession,
    tempKey: string,
    resumeId?: string,
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      let resolved = false;
      const fallback = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        // REVIEW_5 H4：resume 路径下 fallback 直接落在 OLD_ID 上，避免造孤儿 tempKey
        const fallbackId = resumeId ?? tempKey;
        console.warn(`[sdk-bridge] no SDKMessage in 30s, falling back to id ${fallbackId}`);
        internal.realSessionId = fallbackId;
        // 推一条错误消息，让 UI 在新会话里立刻看到出了什么问题，而不是空白等待。
        this.opts.emit({
          sessionId: fallbackId,
          agentId: AGENT_ID,
          kind: 'message',
          payload: {
            text:
              '⚠ SDK 30 秒内未收到任何消息。可能原因：SDK 启动失败 / 鉴权错误 / 代理超限 / 模型不可用。' +
              '请检查 `~/.claude/.credentials.json` 是否存在且有效，或在终端运行 `claude -p "hi"` 验证。',
            error: true,
          },
          ts: Date.now(),
          source: 'sdk',
        });
        resolve(fallbackId);
      }, 30_000);

      void (async () => {
        const realId = await this.consume(
          internal,
          tempKey,
          (id) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(fallback);
            resolve(id);
          },
          resumeId,
        );
        // consume 结束（流自然终止）；如果还没 resolve，用最后已知 id
        if (!resolved) {
          clearTimeout(fallback);
          resolved = true;
          resolve(realId ?? tempKey);
        }
      })();
    });
  }

  /**
   * 持续消费 SDK 消息流，把 SDKMessage 翻译为 AgentEvent。
   * 一旦发现 session_id（来自任意带 session_id 的消息），通过 onFirstId 通知调用方。
   */
  private async consume(
    internal: InternalSession,
    tempKey: string,
    onFirstId: (id: string) => void,
    resumeId?: string,
  ): Promise<string | null> {
    let realId: string | null = null;
    try {
      for await (const msg of internal.query) {
        const m = msg as { type: string; session_id?: string; [k: string]: unknown };

        // 第一次拿到 session_id：完成 key 切换 + 通知 createSession
        if (!realId && typeof m.session_id === 'string' && m.session_id) {
          realId = m.session_id;
          internal.realSessionId = realId;
          if (tempKey !== realId) {
            this.sessions.delete(tempKey);
            this.sessions.set(realId, internal);
            // fallback 路径：createSession 已用 tempKey 调过 claimAsSdk 并 emit 了 session-start，
            // sessionManager 已写入了一条以 tempKey 为 id 的「内」会话占位行（含 permission_mode 等）。
            // 用 rename 而不是 delete + new：保留 tempKey 行的内容（包括用户已选过的 permission_mode、
            // 已落库的事件 / 文件改动 / 总结），整体迁到 realId。renderer 侧通过 session-renamed
            // 事件同步迁移 selectedId / by-session 状态，不会被踢回主界面。
            // REVIEW_7 M3：renameSdkSession 内聚 sdkOwned claim 转移，调用方不再手工 release+claim。
            sessionManager.renameSdkSession(tempKey, realId);
          }

          // CHANGELOG_27 / REVIEW_6：CLI 在 SDK streaming input + resume + 新 prompt 下
          // 隐式 fork —— 实测铁证：resume=OLD_ID, prompt='ping' → first session_id=NEW_ID
          // (≠ OLD_ID)，CLI 内置 fork 与 SDK 文档「forkSession 默认 false 不 fork」不一致。
          // 默认 fork 在更深的 native binary 内，应用层无法关掉。
          //
          // CHANGELOG_24 备注早预警过这个边界，B 方案 (CHANGELOG_26) 落地后用户场景实测
          // 触发：detail 卡在「⚠ SDK 通道已断开」占位 message 后无下文，实时面板冒一条新
          // SDK 会话 = NEW_ID（manager.ensure 把 NEW_ID 当全新会话落库，OLD_ID detail 不动）。
          //
          // 修法：把 OLD_ID 的 DB record + 子表（events / file_changes / summaries）全部
          // rename 成 NEW_ID，让历史"续上"NEW_ID 名下；renderer 通过 session-renamed 自动
          // 把 selectedId / sessions Map / by-session state 迁过去（store.renameSession 已实现）。
          // 副作用：会话 id 字段变了（与 jsonl 文件名一致），但 detail / list 内容完全连续，
          // 用户在 UI 上看不到 sessionId 字段，体感等同「会话续上」。
          //
          // 关键约束（REVIEW_7 L4 修正注释 → 与实际代码顺序一致）：
          // - 实际顺序：本 fork rename(OLD_ID → NEW_ID) 在 onFirstId(realId) 之前（即下面这行 1183 块），
          //   onFirstId 才 resolve waitForRealSessionId，createSession 才走到 line 467 emit session-start。
          //   也就是 rename 在 NEW_ID 的 session-start emit 之前发生 —— 此时 NEW_ID record 在 DB 中
          //   尚不存在。sessionRepo.rename (session-repo.ts:183-218) 对 toExists=false 走 INSERT
          //   复制 OLD_ID 内容（含 permission_mode 等）+ 迁子表 + DELETE OLD_ID 路径，结果与
          //   toExists=true 分支一致——OLD_ID 内容被完整保留到 NEW_ID 名下，干净无遗漏。
          // - claim 转移：renameSdkSession 内聚处理（REVIEW_7 M3），调用方不再手工 release/claim。
          if (resumeId && resumeId !== realId) {
            console.warn(
              `[sdk-bridge] CLI forked: requested resume=${resumeId} but got realId=${realId}; ` +
                `renaming OLD record → NEW so history continues under the new session id`,
            );
            // REVIEW_7 M3：renameSdkSession 内聚 sdkOwned claim 转移（resumeId → realId 原子），
            // 消除 fork 路径「fork rename → onFirstId → createSession 行 453 才 claimAsSdk(realId)」
            // 窗口内 NEW_ID 未 claim、hook 通道抢先 NEW_ID 事件造另一条 record 的微概率风险。
            sessionManager.renameSdkSession(resumeId, realId);
          }

          onFirstId(realId);
        }

        const sid = realId ?? tempKey;
        translateSdkMessage(this.opts.emit, sid, m, internal);
      }
    } catch (err) {
      console.warn(`[sdk-bridge] query loop ended`, err);
      // 应用主动 close（含 approve-bypass 冷切 / SessionManager.delete / 应用退出清理）
      // 时 SDK 抛错（典型 [ede_diagnostic] 状态机不一致 / AbortError）属于设计内副产品，
      // 不弹「⚠ SDK 流中断」红字 message——避免 UI 时间线像系统出错。flag 在 closeSession
      // interrupt 之前 + approve-bypass resolver 之前都打过（双保险）。
      // 仍走 finally 清 pending Maps + emit session-end。
      if (internal.expectedClose) {
        // 早返：跳过 emit 红字，但仍走下面的 finally 兜底清理
      } else {
        // CHANGELOG_47：流中途抛错（鉴权过期 / token 限额 / CLI 子进程崩 / 网络）
        // 之前只 console.warn，UI 时间线只看到 session-end 不知道为什么。补一条 error message。
        const sid = realId ?? tempKey;
        this.opts.emit({
          sessionId: sid,
          agentId: AGENT_ID,
          kind: 'message',
          payload: {
            text: `⚠ SDK 流中断：${(err as Error)?.message ?? String(err)}`,
            error: true,
          },
          ts: Date.now(),
          source: 'sdk',
        });
      }
    } finally {
      const sid = realId ?? tempKey;
      // 流终止时拒掉所有未决的权限请求，避免上游 await 永久挂起
      for (const entry of internal.pendingPermissions.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.resolver({ behavior: 'deny', message: 'session ended', interrupt: true });
      }
      internal.pendingPermissions.clear();
      // AskUserQuestion 同样清空，回调改用「会话结束」标记答复
      for (const entry of internal.pendingAskUserQuestions.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.resolver({
          answers: [{ question: '__session_ended__', selected: [], other: '会话已结束' }],
        });
      }
      internal.pendingAskUserQuestions.clear();
      // ExitPlanMode 同样清空：会话结束 = 默认按「继续规划」回，但 SDK 已经死了所以这只是个 best-effort
      for (const entry of internal.pendingExitPlanModes.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.resolver({ decision: 'keep-planning', feedback: '会话已结束' });
      }
      internal.pendingExitPlanModes.clear();
      this.opts.emit({
        sessionId: sid,
        agentId: AGENT_ID,
        kind: 'session-end',
        payload: { reason: 'sdk-stream-ended' },
        ts: Date.now(),
        source: 'sdk',
      });
      this.sessions.delete(sid);
      this.sessions.delete(tempKey);
      sessionManager.releaseSdkClaim(sid);
    }
    return realId;
  }
}
