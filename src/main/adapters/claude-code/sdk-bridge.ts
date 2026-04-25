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
  AgentEvent,
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
import { getSdkRuntimeOptions, getPathToClaudeCodeExecutable } from '@main/adapters/claude-code/sdk-runtime';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import {
  getAgentDeckPluginPath,
  getAgentDeckSystemPromptAppend,
} from '@main/adapters/claude-code/sdk-injection';
import {
  imageResultToFileChanges,
  parseImageToolResult,
} from '@main/adapters/claude-code/translate';
import { isImageTool } from '@shared/mcp-tools';

const AGENT_ID = 'claude-code';

/**
 * 单条用户消息字节上限（~100KB）。超过这个就拒绝排队，让 UI 抛错给用户看到。
 * 100KB 已经远超合理对话长度（~25k 中文字符），主要是兜底"用户不小心粘了一坨二进制"
 * 或者"复制了整个日志文件"的场景。SDK / Anthropic 端再大也会按 token 计费暴涨。
 */
const MAX_MESSAGE_BYTES = 100_000;

/**
 * 单会话 pendingUserMessages 队列上限。SDK 在 await canUseTool 等待用户响应时
 * 整条 query 阻塞，pendingUserMessages 不被消费；用户连发 10+ 条长 prompt 会无限累积，
 * 内存常驻一堆 SDKUserMessage 对象 + 同步落库 N 条 message 事件，
 * 等用户允许后 SDK 一次性 flush 全部 turn → token 计费暴涨。
 * 20 条已经远超合理"用户连发"场景，超过就拒绝排队，让 UI 提示先处理 pending。
 */
const MAX_PENDING_MESSAGES = 20;

export interface SdkSessionHandle {
  sessionId: string;
  abort: () => void;
}

export interface SdkBridgeOptions {
  emit: (e: AgentEvent) => void;
  /** 权限请求未响应自动 abort 的阈值（毫秒）。0 = 不超时。运行时可通过 setPermissionTimeoutMs 改。 */
  permissionTimeoutMs?: number;
}

interface PendingPermissionEntry {
  payload: PermissionRequest;
  resolver: (r: PermissionResult) => void;
  timer: NodeJS.Timeout | null;
}

interface PendingAskQuestionEntry {
  payload: AskUserQuestionRequest;
  resolver: (a: AskUserQuestionAnswer) => void;
  timer: NodeJS.Timeout | null;
}

interface PendingExitPlanModeEntry {
  payload: ExitPlanModeRequest;
  /** 真正驱动 SDK 行为的 resolver：approve → allow，keep-planning → deny+message */
  resolver: (response: ExitPlanModeResponse) => void;
  /** 拿到原始 input 用于 allow 时回填 updatedInput（保留 plan 字段不变） */
  toolInput: Record<string, unknown>;
  timer: NodeJS.Timeout | null;
}

interface InternalSession {
  /** 等待 SDK 真实 session_id 之前用的临时 id；拿到后会被替换 */
  realSessionId: string | null;
  cwd: string;
  query: Query;
  pendingUserMessages: SDKUserMessage[];
  notify: (() => void) | null;
  /** 等待用户回应的权限请求：requestId → entry（payload + resolver + 超时定时器） */
  pendingPermissions: Map<string, PendingPermissionEntry>;
  /** 等待用户回答的 AskUserQuestion：requestId → entry */
  pendingAskUserQuestions: Map<string, PendingAskQuestionEntry>;
  /** 等待用户批准/继续规划的 ExitPlanMode：requestId → entry */
  pendingExitPlanModes: Map<string, PendingExitPlanModeEntry>;
  /**
   * tool_use_id → tool_name 映射。SDK 的 tool_result block 只带 tool_use_id 不带 toolName，
   * 但我们需要在 tool_result 时识别「这条结果是不是 mcp 图片工具的」才能翻译成 file-changed。
   * assistant.tool_use 处理时 set，user.tool_result 消费后 delete。
   */
  toolUseNames: Map<string, string>;
}

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
  private recovering = new Map<string, Promise<void>>();
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
  }): Promise<SdkSessionHandle> {
    // SDK streaming 协议硬性约束：必须有首条 user message 才会启动 CLI 子进程，
    // 否则 stdin 永远等不到数据 → CLI 不动 → SDK 不发 SDKMessage → 30s 兜底超时。
    // UI 已强制必填，这里再守一道，避免 IPC 直调时静默卡死。
    if (!opts.prompt || !opts.prompt.trim()) {
      throw new Error('首条消息不能为空：SDK streaming 模式需要首条消息才能启动 CLI');
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
              if (response.decision === 'approve') {
                // allow + 原 input 透传：让 ExitPlanMode 工具调用「成功」，
                // CLI 收到 tool_result 自动退出 plan mode，后续工具按非 plan 模式继续。
                resolve({
                  behavior: 'allow',
                  updatedInput: entry.toolInput,
                });
              } else {
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
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: getAgentDeckSystemPromptAppend(),
          },
          // agent-deck 自带 plugin：注入到所有会话（不管 cwd），
          // skill 自动以 `agent-deck:<skill-name>` 命名空间注册。
          // 与用户 ~/.claude/skills/ + project .claude/skills/ 都不冲突（plugin 强制命名空间前缀）。
          plugins: [{ type: 'local', path: getAgentDeckPluginPath() }],
          // 复用本地 Claude Code 配置（hooks / MCP / agents / permissions）
          settingSources: ['user', 'project', 'local'],
          canUseTool,
          // resume：传入历史 sessionId，SDK 会让 CLI 加载 ~/.claude/projects/<cwd>/<sid>.jsonl
          // 续上之前的对话，第一条 SDKMessage 的 session_id 就是这个 sid。
          resume: opts.resume,
          // SDK 默认 spawn 'node'，但 .app 走 launchd 启动时 PATH 不含 nvm/homebrew 的 node。
          // 用 Electron 二进制 + ELECTRON_RUN_AS_NODE=1 复用内置 Node runtime（详见 sdk-runtime.ts）。
          executable: runtime.executable,
          env: runtime.env,
          // SDK 0.2.x 把 cli.js 拆成 native binary（platform-specific 包），SDK 内部
          // require.resolve 拿到的路径在 .app 里走 `app.asar/...`，spawn 走系统 syscall
          // 不经 Electron fs patch → ENOTDIR → query 立刻死。显式传解析后的 unpacked 路径
          // 绕开 SDK 自带 K7。dev 模式下函数返回真实 node_modules 路径，无副作用。
          ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
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
    this.opts.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: { text: '⚠ SDK 通道已断开，正在自动恢复…' },
      ts: Date.now(),
      source: 'sdk',
    });

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
          await this.createSession({
            cwd: rec.cwd,
            prompt: text,
            permissionMode: rec.permissionMode ?? undefined,
          });
          // createSession 走 tempKey → realId rename 路径，OLD_ID 没参与；手工补一次 rename
          // 把 OLD_ID 的应用层身份转到 newRealId。从 sessions Map 找 cwd === rec.cwd 的最新
          // SDK session id 即为 newRealId（createSession resolve 后已注册）。
          let newRealId: string | null = null;
          for (const [sid, internal] of this.sessions.entries()) {
            if (internal.cwd === rec.cwd) {
              newRealId = sid;
              break;
            }
          }
          if (newRealId && newRealId !== sessionId) {
            console.warn(
              `[sdk-bridge] post-fallback rename ${sessionId} → ${newRealId} ` +
                `(carry app-side events/file_changes/summaries history)`,
            );
            sessionManager.releaseSdkClaim(sessionId);
            sessionManager.renameSdkSession(sessionId, newRealId);
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

  /** 用户对 ExitPlanMode 的决策（批准 / 继续规划），驱动 SDK allow / deny。 */
  respondExitPlanMode(
    sessionId: string,
    requestId: string,
    response: ExitPlanModeResponse,
  ): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const entry = s.pendingExitPlanModes.get(requestId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    s.pendingExitPlanModes.delete(requestId);
    entry.resolver(response);
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
    try {
      await internal.query?.interrupt?.();
    } catch (err) {
      console.warn(`[sdk-bridge] interrupt during close failed: ${sessionId}`, err);
    }

    // 2. 兜底清 pending timer：abort 信号 propagate 不一定立即触发所有 entry handler，
    //    timer 残留 30s+ 会让进程持有 callback 引用。clear Map 也避免延迟 resolver 收到时
    //    Map 已空再 set 出错。
    for (const entry of internal.pendingPermissions.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    internal.pendingPermissions.clear();
    for (const entry of internal.pendingAskUserQuestions.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    internal.pendingAskUserQuestions.clear();
    for (const entry of internal.pendingExitPlanModes.values()) {
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
            sessionManager.releaseSdkClaim(tempKey);
            sessionManager.claimAsSdk(realId);
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
          // 关键约束：
          // - rename 必须在 createSession line 465 emit session-start 之后（manager 已 ensure
          //   了 NEW_ID record），rename(OLD_ID → NEW_ID) 走 sessionRepo.rename 的 toExists
          //   分支：不复制 OLD_ID record 但子表全迁，再 delete OLD_ID record，干净
          // - claim 转移：OLD_ID 在 createSession line 176-178 已 claimAsSdk，要 release；
          //   NEW_ID 在 createSession line 451 已 claimAsSdk，无需重复
          if (resumeId && resumeId !== realId) {
            console.warn(
              `[sdk-bridge] CLI forked: requested resume=${resumeId} but got realId=${realId}; ` +
                `renaming OLD record → NEW so history continues under the new session id`,
            );
            sessionManager.releaseSdkClaim(resumeId);
            sessionManager.renameSdkSession(resumeId, realId);
          }

          onFirstId(realId);
        }

        const sid = realId ?? tempKey;
        this.translate(sid, m, internal);
      }
    } catch (err) {
      console.warn(`[sdk-bridge] query loop ended`, err);
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

  private translate(
    sessionId: string,
    msg: { type: string; [k: string]: unknown },
    internal: InternalSession,
  ): void {
    const ts = Date.now();
    const emit = (kind: AgentEvent['kind'], payload: unknown): void => {
      this.opts.emit({ sessionId, agentId: AGENT_ID, kind, payload, ts, source: 'sdk' });
    };

    if (msg.type === 'assistant') {
      const m = msg.message as {
        content?: {
          type: string;
          text?: string;
          name?: string;
          input?: unknown;
          id?: string;
          thinking?: string;
        }[];
      };
      // SDK 给 assistant 消息附带 error 字段时（rate_limit / billing_error / auth 等），
      // 把它当成一条错误文案推到时间线，UI 能立刻看到 CLI 报的真实问题。
      const errCode = (msg as { error?: string }).error;
      if (errCode) {
        emit('message', { text: `⚠ Claude API 错误：${errCode}`, error: true });
      }
      const blocks = m?.content ?? [];
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          // Anthropic API 标准 BetaThinkingBlock { type:'thinking', thinking, signature }
          // 与 BetaRedactedThinkingBlock { type:'redacted_thinking', data }；
          // redacted 内容已加密，UI 显示占位符即可。
          const text =
            block.type === 'thinking' ? (block.thinking ?? '').trim() : '[redacted thinking]';
          if (text) emit('thinking', { text });
        } else if (block.type === 'text' && block.text) {
          // 同一帧 SDK assistant message 里出现多个连续 text block，是 Claude Code
          // 把 extended thinking block 压平成 text 推给 SDK 的产物：紧邻另一个 text 的
          // 当前 block 是 thinking-prelude，最后一段才是 final answer。
          // 判断条件「下一个紧邻 block 也是 text」覆盖：
          //   [text, text]            → block[0] thinking, block[1] message
          //   [text, tool_use]        → block[0] message （tool 调用前的解释，非 thinking）
          //   [text, tool_use, text]  → 两段 text 都是 message（被 tool_use 隔开）
          //   [text, text, tool_use]  → block[0] thinking, block[1] message
          const next = blocks[i + 1];
          const isThinkingPrelude = !!(next && next.type === 'text' && next.text);
          if (isThinkingPrelude) {
            emit('thinking', { text: block.text });
          } else {
            emit('message', { text: block.text, role: 'assistant' });
          }
        } else if (block.type === 'tool_use') {
          // 反查需要：tool_result block 只带 tool_use_id 没 toolName，必须靠这条记录
          if (block.id && block.name) {
            internal.toolUseNames.set(block.id, block.name);
          }
          emit('tool-use-start', {
            toolName: block.name,
            toolInput: block.input,
            toolUseId: block.id,
          });
          // 同时把 Edit/Write/MultiEdit 翻译成 file-changed（用 input 重建 before/after）
          this.maybeEmitFileChanged(emit, block.name, block.input, block.id);
        }
      }
    } else if (msg.type === 'user') {
      const m = msg.message as {
        content?: { type: string; tool_use_id?: string; content?: unknown }[];
      };
      const blocks = m?.content ?? [];
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          emit('tool-use-end', {
            toolUseId: block.tool_use_id,
            toolResult: block.content,
          });
          // mcp 图片工具结果识别：反查 toolName，匹配则把 result.content 解析后翻译成 file-changed
          this.maybeEmitImageFileChanged(emit, internal, block.tool_use_id, block.content);
        }
      }
    } else if (msg.type === 'result') {
      const r = msg as {
        subtype?: string;
        is_error?: boolean;
        result?: string;
        errors?: string[];
      };
      // 错误结果：把 errors 数组或 result 文本作为一条错误消息推给 UI，
      // 否则只看到 finished 事件用户不知道为什么"完成"了。
      if (r.is_error || (r.subtype && r.subtype !== 'success')) {
        const detail = r.errors?.join('\n') ?? r.result ?? r.subtype ?? 'unknown error';
        emit('message', { text: `⚠ ${detail}`, error: true });
      }
      emit('finished', { ok: r.subtype === 'success' && !r.is_error, subtype: r.subtype });
    }
    // type === 'system' 等忽略
  }

  private maybeEmitFileChanged(
    emit: (kind: AgentEvent['kind'], payload: unknown) => void,
    toolName: string | undefined,
    input: unknown,
    toolUseId: string | undefined,
  ): void {
    if (!toolName) return;
    const i = (input ?? {}) as {
      file_path?: string;
      old_string?: string;
      new_string?: string;
      content?: string;
      edits?: { old_string: string; new_string: string }[];
    };
    if (toolName === 'Edit' && i.file_path) {
      emit('file-changed', {
        filePath: i.file_path,
        kind: 'text',
        before: i.old_string ?? null,
        after: i.new_string ?? null,
        metadata: { source: 'Edit' },
        toolCallId: toolUseId,
      });
    } else if (toolName === 'Write' && i.file_path) {
      emit('file-changed', {
        filePath: i.file_path,
        kind: 'text',
        before: null,
        after: i.content ?? null,
        metadata: { source: 'Write' },
        toolCallId: toolUseId,
      });
    } else if (toolName === 'MultiEdit' && i.file_path && Array.isArray(i.edits)) {
      const before = i.edits.map((e) => e.old_string).join('\n---\n');
      const after = i.edits.map((e) => e.new_string).join('\n---\n');
      emit('file-changed', {
        filePath: i.file_path,
        kind: 'text',
        before,
        after,
        metadata: { source: 'MultiEdit', editCount: i.edits.length },
        toolCallId: toolUseId,
      });
    }
  }

  /**
   * MCP 图片工具的 tool_result 处理：反查 toolName 是否是 mcp__*__Image*，
   * 是则解析 result.content 里的 JSON 翻译成 0~N 条 file-changed（payload.before/after 是 ImageSource）。
   *
   * CHANGELOG_47：toolUseNames.delete 提到顶层、对所有 tool_result 都执行。
   * 之前只在图片工具分支末尾 delete，导致普通工具（Bash/Edit/Read…）每条 turn 漏一条，
   * 长会话 toolUseNames Map 线性增长直到 session-end 才清空。
   */
  private maybeEmitImageFileChanged(
    emit: (kind: AgentEvent['kind'], payload: unknown) => void,
    internal: InternalSession,
    toolUseId: string | undefined,
    content: unknown,
  ): void {
    if (!toolUseId) return;
    const toolName = internal.toolUseNames.get(toolUseId);
    // 收到 tool_result 即可消费这条映射，无论是否图片工具
    internal.toolUseNames.delete(toolUseId);
    if (!isImageTool(toolName)) return;
    const parsed = parseImageToolResult(content);
    if (!parsed) return;
    for (const fc of imageResultToFileChanges(parsed, toolUseId)) {
      emit('file-changed', fc);
    }
  }
}

/**
 * 把用户在 UI 上对 AskUserQuestion 的选择拼成可读文本，
 * 塞进 SDK 反馈给 Claude 的 deny.message 里。
 */
function formatAskAnswers(
  questions: AskUserQuestionItem[],
  answer: AskUserQuestionAnswer,
): string {
  const lines: string[] = [];
  const ansByQ = new Map<string, { selected: string[]; other?: string }>();
  for (const a of answer.answers ?? []) {
    ansByQ.set(a.question, { selected: a.selected ?? [], other: a.other });
  }
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    const a = ansByQ.get(q.question) ?? { selected: [], other: undefined };
    const parts: string[] = [];
    if (a.selected.length > 0) parts.push(a.selected.join(', '));
    if (a.other) parts.push(`其他：${a.other}`);
    lines.push(`Q${i + 1}: ${q.question}\nA: ${parts.length ? parts.join(' | ') : '(未作答)'}`);
  }
  return lines.join('\n\n');
}
