import { randomUUID } from 'node:crypto';
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
import { getSdkRuntimeOptions } from '@main/adapters/claude-code/sdk-runtime';

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

// 用 new Function 构造 dynamic import 避开 Vite 静态分析（否则会被转成 require()，
// 而 @anthropic-ai/claude-agent-sdk 是 ESM-only 包，无法被 require）。
const dynamicImport = new Function('s', 'return import(s)') as <T = unknown>(s: string) => Promise<T>;

let sdkPromise: Promise<SdkModule> | null = null;
async function loadSdk(): Promise<SdkModule> {
  if (!sdkPromise) {
    sdkPromise = dynamicImport<SdkModule>('@anthropic-ai/claude-agent-sdk');
  }
  return sdkPromise;
}

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
    systemPrompt?: string;
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
    const releasePending = sessionManager.expectSdkSession(opts.cwd);
    const internal: InternalSession = {
      realSessionId: null,
      cwd: opts.cwd,
      query: undefined as unknown as Query,
      pendingUserMessages: [],
      notify: null,
      pendingPermissions: new Map(),
      pendingAskUserQuestions: new Map(),
      pendingExitPlanModes: new Map(),
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

    const { query } = await loadSdk();
    const runtime = getSdkRuntimeOptions();
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
        systemPrompt: opts.systemPrompt,
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
      },
    });
    internal.query = q;
    this.sessions.set(tempKey, internal);

    // 等待第一条带 session_id 的 SDKMessage（system init 几乎一定会先到）
    const realId = await this.waitForRealSessionId(internal, tempKey);

    // 注册到 SessionManager 的 sdk-owned 集合，后续 hook 回环将被去重
    sessionManager.claimAsSdk(realId);
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
    if (!s) throw new Error(`session ${sessionId} not found`);

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
   */
  private waitForRealSessionId(internal: InternalSession, tempKey: string): Promise<string> {
    return new Promise<string>((resolve) => {
      let resolved = false;
      const fallback = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        console.warn(`[sdk-bridge] no SDKMessage in 30s, falling back to temp id ${tempKey}`);
        internal.realSessionId = tempKey;
        // 推一条错误消息，让 UI 在新会话里立刻看到出了什么问题，而不是空白等待。
        this.opts.emit({
          sessionId: tempKey,
          agentId: AGENT_ID,
          kind: 'message',
          payload: {
            text:
              '⚠ SDK 30 秒内未收到 CLI 任何消息。可能原因：CLI 启动失败 / 鉴权错误 / 代理超限 / 模型不可用。' +
              '请在终端运行 `node node_modules/@anthropic-ai/claude-agent-sdk/cli.js -p "hi"` 验证。',
            error: true,
          },
          ts: Date.now(),
          source: 'sdk',
        });
        resolve(tempKey);
      }, 30_000);

      void (async () => {
        const realId = await this.consume(internal, tempKey, (id) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(fallback);
          resolve(id);
        });
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
          onFirstId(realId);
        }

        const sid = realId ?? tempKey;
        this.translate(sid, m);
      }
    } catch (err) {
      console.warn(`[sdk-bridge] query loop ended`, err);
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
  ): void {
    const ts = Date.now();
    const emit = (kind: AgentEvent['kind'], payload: unknown): void => {
      this.opts.emit({ sessionId, agentId: AGENT_ID, kind, payload, ts, source: 'sdk' });
    };

    if (msg.type === 'assistant') {
      const m = msg.message as {
        content?: { type: string; text?: string; name?: string; input?: unknown; id?: string }[];
      };
      // SDK 给 assistant 消息附带 error 字段时（rate_limit / billing_error / auth 等），
      // 把它当成一条错误文案推到时间线，UI 能立刻看到 CLI 报的真实问题。
      const errCode = (msg as { error?: string }).error;
      if (errCode) {
        emit('message', { text: `⚠ Claude API 错误：${errCode}`, error: true });
      }
      const blocks = m?.content ?? [];
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          emit('message', { text: block.text, role: 'assistant' });
        } else if (block.type === 'tool_use') {
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
