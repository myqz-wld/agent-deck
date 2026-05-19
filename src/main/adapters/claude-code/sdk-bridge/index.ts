import { randomUUID } from 'node:crypto';
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
import { sessionManager } from '@main/session/manager';
import { getSdkRuntimeOptions, getPathToClaudeCodeExecutable } from '@main/adapters/claude-code/sdk-runtime';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import {
  getAgentDeckPluginsForSession,
  getAgentDeckSystemPromptAppend,
} from '@main/adapters/claude-code/sdk-injection';
import { buildSandboxOptions } from '@main/adapters/claude-code/sandbox-config';
import { summariseSessionForHandOff } from '@main/session/summarizer/llm-runners';
// CHANGELOG_52 Step 3a-3g + CHANGELOG_85 Step 3.2：拆 class 完成。本目录（sdk-bridge/）
// 含 11 个 sub-module + index.ts (facade)。
//
// **TS module resolution 假设**（F5 finding）：moduleResolution: node 模式下
// `import './sdk-bridge'` 优先匹配 `sdk-bridge.ts` 文件（不存在时才走 `sdk-bridge/index.ts`）。
// Step 3g 删了原 `sdk-bridge.ts` 文件，import 自动切到本 index.ts；外部 import 站点
// （如 `@main/adapters/claude-code/sdk-bridge`）零变更继续工作。
//
// **如果未来切到 node16/bundler module resolution** 此优先级会变（强 ESM 要 explicit
// `/index` 后缀），届时所有 import 站点要加 `/index`。当前 tsconfig.node.json 用 node。
import {
  AGENT_ID,
} from './constants';
import type {
  InternalSession,
  SdkBridgeOptions,
  SdkSessionHandle,
} from './types';
import { makeInternalSession } from './types';
import { PermissionResponder } from './permission-responder';
import { makeCanUseTool } from './can-use-tool';
import { SessionRecoverer, defaultResumeJsonlExists, defaultCwdExists } from './recoverer';
import { StreamProcessor } from './stream-processor';
import { RestartController } from './restart-controller';
import { runCloseSessionCleanup } from './pending-cancellation';
import { buildMcpServersForSession } from './mcp-server-init';
import { buildClaudeQueryOptions } from './query-options-builder';
import { validateSendMessageOrThrow } from './send-validation';
import { finalizeSessionStart } from './session-finalize';
import { resolveClaudeSandboxMode } from './sandbox-resolve';
import { resolveClaudeModel } from './model-resolve';

export type { SdkSessionHandle, SdkBridgeOptions } from './types';

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
   * sendMessage「断连自愈」单飞表（CHANGELOG_26 / B 方案）：sessionId → 正在跑的
   * createSession({resume,prompt}) Promise。同 sessionId 并发等同一个 Promise。
   *
   * **SHARED with restartController**（CHANGELOG_52 Step 3d / F2）：双方 mutate 同一份
   * Map，不是 recoverer 独占。详 recoverer.ts / restart-controller.ts state 节。
   */
  private recovering = new Map<string, Promise<unknown>>();

  /** 权限请求未响应自动 abort 阈值；0 = 关闭。运行时通过 setPermissionTimeoutMs 改。 */
  private permissionTimeoutMs: number;

  /** 详 permission-responder.ts —— 6 respond/list + 3 timeout 方法 sub-class。 */
  private responder: PermissionResponder;

  /** 详 recoverer.ts —— recoverAndSend 主体 + placeholderEmittedAt 独占 Map。 */
  private recoverer: SessionRecoverer;

  /** 详 stream-processor.ts —— makeUserMessage / createUserMessageStream / waitForRealSessionId / consume。 */
  private streamProcessor: StreamProcessor;

  /** 详 restart-controller.ts —— restartWithPermissionMode + restartWithClaudeCodeSandbox 冷切。 */
  private restartController: RestartController;

  constructor(private opts: SdkBridgeOptions) {
    this.permissionTimeoutMs = Math.max(0, opts.permissionTimeoutMs ?? 0);

    // RestartController 必须先 init：PermissionResponder ctx thunk 要 restart ref
    this.restartController = new RestartController({
      recovering: this.recovering,
      emit: opts.emit,
      closeSession: (sid) => this.closeSession(sid),
      createSession: (createOpts) => this.createSession(createOpts).then((h) => h),
    });

    this.responder = new PermissionResponder(
      {
        sessions: this.sessions,
        emit: opts.emit,
        getPermissionTimeoutMs: () => this.permissionTimeoutMs,
      },
      (sid, mode, prompt) => this.restartController.restartWithPermissionMode(sid, mode, prompt),
    );

    // arrow 闭包 this，运行时晚解析 → this.createSession 一定已绑定。
    // attachments 透传 sendMessage 第三参（HIGH-1：避免 inflight 第二条等待者丢图）。
    // CHANGELOG_99：cwdExists thunk 也走 facade extend override 模式(同 resumeJsonlExists)
    // CHANGELOG_107: summariseFn thunk 同款 facade extend override 模式,默认实现 =
    // summariseSessionForHandOff,Step 2 起 prependHistorySummary helper 调它。
    this.recoverer = new SessionRecoverer(
      { recovering: this.recovering, emit: opts.emit },
      (createOpts) => this.createSession(createOpts),
      (sid, text, attachments) => this.sendMessage(sid, text, attachments),
      (cwd, sid) => this.resumeJsonlExists(cwd, sid),
      (cwd) => this.cwdExists(cwd),
      (cwd, events) => this.summariseForHandOff(cwd, events),
    );

    this.streamProcessor = new StreamProcessor({ sessions: this.sessions, emit: opts.emit });
  }

  /** 调整超时阈值。0 = 关闭。只影响新建的 pending；老的保持原 timer。 */
  setPermissionTimeoutMs(ms: number): void {
    this.permissionTimeoutMs = Math.max(0, ms);
  }

  async createSession(opts: {
    cwd: string;
    prompt?: string;
    permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
    /** 传 sessionId 表示恢复历史会话（CLI 会从 ~/.claude/projects/<cwd>/<sid>.jsonl 续上）。 */
    resume?: string;
    /**
     * R3 universal team backend：team_name 仅作 sessionManager.recordCreatedTeamName
     * 入口标签使用，不再触发 Claude CLI 实验特性 env 注入（CHANGELOG_45/46 老路径已 R3.E6 删除）。
     */
    teamName?: string;
    /** 首条 user message 的图片附件（path 由 IPC 层 writeUploadedImage 落盘后传入）。 */
    attachments?: UploadedAttachmentRef[];
    /**
     * CHANGELOG_74：Claude Code OS 沙盒 per-session 覆盖（NewSessionDialog / ComposerSdk
     * 切档传入）。undefined → fallback 链：opts.resume 路径读 sessionRepo.claudeCodeSandbox →
     * settings.claudeCodeSandbox 全局值 → 'off' 兜底。与 codex codexSandbox 字面镜像。
     */
    claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict';
    /**
     * REVIEW_36 R2 HIGH-B + MED-C：可选额外 writable roots（仅 workspace-write 档生效）。
     * 典型场景：
     * - hand_off_session 外置 worktree（cwd=worktreePath）→ 传 `[mainRepo]` 让 session 能写 mainRepo plan
     * - recoverer cwd fallback → 传 `[原 mainRepo]` 防写权限静默扩大到 fallback 父目录
     */
    extraAllowWrite?: readonly string[];
    /**
     * plan model-wiring-and-handoff-20260514 Step 2.2：SDK / agent model 透传。
     * 来源：spawn handler 解 agent body frontmatter `model` 字段（reviewer-claude.md 的
     * `model: opus` 等）后传入。fallback 链 opts.model > sessionRepo.model > undefined
     * （详 model-resolve.ts）。透传给 SDK `query({ options.model })` 真正生效，并
     * setModel 持久化让 resume / dormant 唤醒后保持一致。
     */
    model?: string;
  }): Promise<SdkSessionHandle> {
    // SDK streaming 协议硬性约束：必须有首条 user message 才会启动 CLI 子进程，
    // 否则 stdin 永远等不到数据 → CLI 不动 → SDK 不发 SDKMessage → 30s 兜底超时。
    // UI 已强制必填，这里再守一道，避免 IPC 直调时静默卡死。
    if (!opts.prompt || !opts.prompt.trim()) {
      throw new Error('首条消息不能为空：SDK streaming 模式需要首条消息才能启动 CLI');
    }
    // R3.E6：删除老 Claude Code experimental teams flag 相关 resume + teamName warn —— teamName
    // 现在仅作 universal team 抽象的入口标签，与 Claude CLI 实验特性无关，无 resume race。
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
    // CHANGELOG_85 Step 3.2：InternalSession 字段初值集中到 types.ts:makeInternalSession factory
    // （permissionMode 与 query options 同源 `opts.permissionMode ?? 'default'`，详
    // makeInternalSession + InternalSession.permissionMode 字段 jsdoc）。
    const internal = makeInternalSession({
      cwd: opts.cwd,
      permissionMode: opts.permissionMode,
    });

    if (opts.prompt) {
      // 用 tempKey 占位 session_id，实际 SDK 会忽略这个字段（用自己的）
      internal.pendingUserMessages.push(
        this.streamProcessor.makeUserMessage(tempKey, opts.prompt, opts.attachments),
      );
    }

    const userMessageIterable = this.streamProcessor.createUserMessageStream(internal, tempKey);

    // 鉴权 / 模型映射 / 代理地址等都来自 ~/.claude/settings.json 的 env 字段，
    // 由 main bootstrap 阶段的 applyClaudeSettingsEnv() 注入到 process.env，
    // SDK spawn 的 CLI 子进程会继承，与终端 `claude` 用同一套配置。

    // CHANGELOG_52 Step 3c：canUseTool 巨型 callback (~275 行) 抽到 sdk-bridge/can-use-tool.ts。
    // class state 通过 deps 注入（internal / sessionId getter / emit / 超时阈值 / responder ref）。
    // 护栏（READ_ONLY 白名单 / SandboxNetworkAccess auto-deny / approve+plan deny+message
    // / approve-bypass deny+interrupt / 超时 timer + abort listener）全部完整保留在 module。
    const canUseTool = makeCanUseTool({
      internal,
      // realId lazy getter：canUseTool 第一次被 SDK 调用时一定在 waitForRealSessionId 之后，
      // 所以 internal.realSessionId 已经被赋值；wait 之前的兜底用 tempKey（与原 inline 行为一致）
      getSessionId: () => internal.realSessionId ?? tempKey,
      // CHANGELOG_72 Bug 3：bypass 短路读 internal.permissionMode（与 SDK options 同源），
      // 不查 sessionRepo —— 避免 createSession 期间 sessionRepo 还没记录 permission_mode 的 race。
      getPermissionMode: () => internal.permissionMode,
      emit: this.opts.emit,
      getPermissionTimeoutMs: () => this.permissionTimeoutMs,
      responder: this.responder,
    });

    // 整段 await 链（loadSdk → query 构造 → waitForRealSessionId）任一步抛错都要
    // 释放 pending cwd 标记 + 清掉 sessions map 的 tempKey。CHANGELOG_47 修：
    // 之前 releasePending 只在成功路径调，失败时 60s ttl 内同 cwd 真实外部 hook 会话被误吞。
    let realId: string;
    // CHANGELOG_85 Step 3.2：sandbox mode fallback 链抽到 sandbox-resolve.ts。
    // 提到 try 块外，让 emit session-start 之后的 setClaudeCodeSandbox 持久化用同一变量。
    const claudeSandboxMode = resolveClaudeSandboxMode(opts);
    // plan model-wiring-and-handoff-20260514 Step 2.2：model fallback 链抽到 model-resolve.ts。
    // 提到 try 块外让 finalizeSessionStart 持久化用同一变量（与 sandbox 同模式）。
    const claudeModel = resolveClaudeModel(opts);
    try {
      const { query } = await loadSdk();
      const runtime = getSdkRuntimeOptions();
      const claudeBinary = getPathToClaudeCodeExecutable();
      // REVIEW_14 阶段 2 排查盲点：sandbox 是否生效在 SDK / OS 层不打 log，应用主进程
      // 看不到「sandbox 装载成功 / 失败」信号；改回顶层 sandbox 字段后此 log 帮助
      // 实证「buildSandboxOptions 真的传了对应配置进 SDK options」，下次问题排查少绕一圈。
      const sandboxOpts = buildSandboxOptions(claudeSandboxMode, opts.cwd, opts.extraAllowWrite);
      console.log(
        `[sandbox] mode=${claudeSandboxMode} → ${
          sandboxOpts.sandbox ? 'enabled (top-level)' : 'disabled (no field)'
        }${
          opts.extraAllowWrite && opts.extraAllowWrite.length > 0
            ? ` extraAllowWrite=[${opts.extraAllowWrite.join(', ')}]`
            : ''
        }`,
      );
      // CHANGELOG_85 Step 3.2：mcp server 拼装抽到 mcp-server-init.ts
      // （settings.enableTaskManager / enableAgentDeckMcp 两 toggle 独立，可同开 / 同关 / 单挂）
      const mcpServers = await buildMcpServersForSession(internal, tempKey);
      const q = query({
        prompt: userMessageIterable,
        // CHANGELOG_85 Step 3.2：query() options 整段抽到 query-options-builder.ts
        // （pure builder，所有外部依赖通过 args 显式注入，零 side effect）
        options: buildClaudeQueryOptions({
          cwd: opts.cwd,
          permissionMode: opts.permissionMode,
          resume: opts.resume,
          canUseTool,
          sandboxOpts,
          systemPromptAppend: getAgentDeckSystemPromptAppend(),
          plugins: getAgentDeckPluginsForSession(),
          runtime,
          claudeBinary,
          mcpServers,
          model: claudeModel,
        }),
      });
      internal.query = q;
      this.sessions.set(tempKey, internal);

      // 等待第一条带 session_id 的 SDKMessage（system init 几乎一定会先到）
      // REVIEW_5 H4：把 opts.resume 传下去，30s fallback 时用 OLD_ID 作 sessionId
      // 替代 tempKey emit 占位事件，让 ingest 走 existing 分支不再创建第二条 active record
      realId = await this.streamProcessor.waitForRealSessionId(internal, tempKey, opts.resume);

      // A1-HIGH-1 修法（plan deep-review-batch-a1-b-fixes-20260519 / REVIEW_46）:
      // 旧 impl waitForRealSessionId 在 SDK 流结束但从未发 first session_id frame 时
      // resolve(realId ?? tempKey) = tempKey（stream-processor.ts:180）。createSession 继续
      // 走 finalizeSessionStart 创建一条 sessionId=tempKey 的假 DB record（无 SDK live state）
      // + opts.resume 的 sdkOwned claim 永不释放（OLD_ID 后续 hook 事件被静默吞 = leak）。
      // 修法 (A) 彻底失败语义: realId === tempKey 表示 consume 自吞错且 fallback 也没拿到
      // resumeId（非 resume 路径）→ throw 让 createSession 进 catch L298 走完整 cleanup
      // （sessions.delete + releasePending + releaseSdkClaim(opts.resume) + throw IPC）。
      // renderer 收到 error 直接显示，不创建假会话（A1-HIGH-1 双方共识真问题 + reviewer-claude
      // 反驳轮精确时序追踪铁证 + lead 现场验证 finalizeSessionStart emit session-start 链路写
      // sessionId=tempKey 的 DB record + sessions.delete(tempKey) 后 finalize 仍执行）。
      if (realId === tempKey) {
        throw new Error(
          'createSession: SDK stream ended without emitting first session_id frame ' +
            '(consume swallowed SDK error / no resume id available). ' +
            'Refusing to create a session-less DB record.',
        );
      }

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

    // CHANGELOG_85 Step 3.2：emit session-start + 持久化 sandbox + 补 emit 首条 prompt
    // 三段固定 finalize 链抽到 session-finalize.ts。
    // plan cross-adapter-parity-20260515 Phase A Step A.5: extraAllowWrite 同 claudeModel
    // 同款持久化(spawn-time 透传给 finalizeSessionStart → setExtraAllowWrite 写库),让
    // recoverer fallback / resume 路径读回交还 SDK sandbox.allowWrite。
    finalizeSessionStart({
      realId,
      cwd: opts.cwd,
      prompt: opts.prompt,
      claudeSandboxMode,
      claudeModel,
      extraAllowWrite: opts.extraAllowWrite,
      emit: this.opts.emit,
    });

    return {
      sessionId: realId,
      abort: () => void this.interrupt(realId),
    };
  }

  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
  ): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      // 通道死了（dev 重启 / SDK 流自然终止 / 历史会话 lifecycle 已 dormant 或 closed 等）。
      // 早期靠 throw 'not found' 让 renderer 自己识别再调 createAdapterSession({resume:...})；
      // CHANGELOG_26 / B 方案：把恢复语义沉到 adapter owner 层，renderer 不感知 resume 实现细节。
      // 委托 recoverer.recoverAndSend：单飞 + 完整复用 createSession（H4/H1 全套护栏不绕）。
      // CHANGELOG_52 Step 3d：实现迁到 SessionRecoverer，class 上 sendMessage 路径不变。
      // attachments 透传：HIGH-1 修法，避免 inflight 第二条等待者丢图
      //
      // plan cross-adapter-parity-20260515 Phase B Step B.3:recoverAndSend signature 改
      // Promise<string>(返 finalId)。本 caller(bridge sendMessage)**不消费**返回值 —
      // bridge sendMessage 整个 return 流程结束;但 recoverAndSend 内部 inflight 等待者 path
      // 通过 `await inflight` 拿同款 finalId 调 sendThunk → bridge.sendMessage(finalId, ...)
      // 直接命中 sessions Map(主 recovery 完成后已 sync),不再撞 OLD sid not found(REVIEW_40
      // R2 reviewer-codex MED parity 限制治法,plan §B 主体)。
      await this.recoverer.recoverAndSend(sessionId, text, attachments);
      // 失败仍 throw 给 IPC，与原 'not found' 路径行为一致。
      return;
    }

    // CHANGELOG_85 Step 3.2：3 段 pre-condition check 抽到 send-validation.ts
    // （长度上限 / 队列上限 / pending warning emit）。
    validateSendMessageOrThrow(s, sessionId, text, this.opts.emit);

    s.pendingUserMessages.push(
      this.streamProcessor.makeUserMessage(sessionId, text, attachments),
    );
    s.notify?.();
    // 把用户输入也作为一条 message event emit 出去，详情面板能看到完整对话；
    // role: 'user' 让 UI 区分用户/Claude；attachments path 进 events.payload，
    // 历史 detail view 用 UploadedImageThumb 走新 IPC loadUploadedImage 渲染
    this.opts.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: {
        text,
        role: 'user',
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      },
      ts: Date.now(),
      source: 'sdk',
    });
  }

  /**
   * 预检 CLI resume 用的 jsonl 文件是否存在。
   *
   * CHANGELOG_52 Step 3d：本方法是 facade 上的 protected wrapper，让 test 通过子类化
   * override 不依赖真 ~/.claude/projects 目录；实际实现走 module-level
   * `defaultResumeJsonlExists`（行为字节级等价）。
   *
   * 不存在时 CLI `--resume <sid>` 会 hard fail 抛 "No conversation found"，必须走不带
   * resume 的新建路径（CHANGELOG_28）。这条规则跨 OS 是否一致存疑（Linux 同样规则，
   * Windows 未验证），如果 CLI 内部规则未来改了，预检会假阴性 → 退化到原 try-and-fail 行为。
   */
  protected resumeJsonlExists(cwd: string, sessionId: string): boolean {
    return defaultResumeJsonlExists(cwd, sessionId);
  }

  /**
   * CHANGELOG_99 cwd 失效根治:cwd 存在性 protected wrapper。
   *
   * 让 test 通过子类化 override 不依赖真 fs(同 resumeJsonlExists 模式),实际走 module-level
   * `defaultCwdExists`(直接 existsSync,异常 fail-safe 退化返回 true 让 SDK 自己 try)。
   *
   * recoverer 拿这个判定 sessionRepo.cwd 是否还有效;不存在时走 `findFallbackCwd` 启发式
   * fallback 路径(典型场景:K2 老 session cwd=worktree 后 worktree 被 archive_plan 删 /
   * 用户手动 git worktree remove / 跨设备同步丢目录)。
   */
  protected cwdExists(cwd: string): boolean {
    return defaultCwdExists(cwd);
  }

  /**
   * CHANGELOG_107: LLM 摘要 protected wrapper(同 resumeJsonlExists / cwdExists 模式)。
   *
   * 让 test 通过子类化 override 不调真 LLM(撞 OAuth / 计费 / DB 未 init);实际走
   * module-level `summariseSessionForHandOff`(sonnet + 60s timeout + 4 节结构化输出)。
   *
   * recoverer 拿这个 thunk 在 jsonl missing fallback / cwdFellBack=true 路径前生成
   * 摘要 prepend 到 fresh CLI 首条 prompt(Step 2 prependHistorySummary helper)。
   *
   * 失败语义参见 SummariseFnThunk type jsdoc。
   */
  protected summariseForHandOff(cwd: string, events: AgentEvent[]): Promise<string | null> {
    return summariseSessionForHandOff(cwd, events);
  }

  // CHANGELOG_52 Step 3b：6 respond/list 方法 + 3 timeout 方法迁到 PermissionResponder。
  // class 上保留薄 wrapper（保持 public API 与 timeout setTimeout 引用兼容），
  // 真正实现见 sdk-bridge/permission-responder.ts。

  respondPermission(sessionId: string, requestId: string, response: PermissionResponse): void {
    return this.responder.respondPermission(sessionId, requestId, response);
  }

  respondAskUserQuestion(
    sessionId: string,
    requestId: string,
    answer: AskUserQuestionAnswer,
  ): void {
    return this.responder.respondAskUserQuestion(sessionId, requestId, answer);
  }

  async respondExitPlanMode(
    sessionId: string,
    requestId: string,
    response: ExitPlanModeResponse,
  ): Promise<void> {
    return this.responder.respondExitPlanMode(sessionId, requestId, response);
  }

  listPending(sessionId: string): {
    permissions: PermissionRequest[];
    askQuestions: AskUserQuestionRequest[];
    exitPlanModes: ExitPlanModeRequest[];
  } {
    return this.responder.listPending(sessionId);
  }

  listAllPending(): Record<
    string,
    {
      permissions: PermissionRequest[];
      askQuestions: AskUserQuestionRequest[];
      exitPlanModes: ExitPlanModeRequest[];
    }
  > {
    return this.responder.listAllPending();
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

    // 2-5. cleanup 链 — pending cancel + sdkOwned release + zombie row 兜底 + notify wakeup。
    //      整套抽到 pending-cancellation.ts:runCloseSessionCleanup（CHANGELOG_85 Step 3.2）。
    //      详见该 helper jsdoc：清三 Map / sessions.delete / releaseSdkClaim / markRecentlyDeleted /
    //      唤醒 createUserMessageStream 的 await。
    runCloseSessionCleanup({
      sessions: this.sessions,
      internal,
      key,
      sessionId,
      emit: this.opts.emit,
    });
  }

  /** 运行时切换权限模式。SDK 会从下一次工具调用起按新模式判断。 */
  async setPermissionMode(
    sessionId: string,
    mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions',
  ): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`session ${sessionId} not found`);
    // CHANGELOG_72 Bug 3：先同步 in-memory cache 再 await SDK，让下一次 canUseTool
    // bypass 短路立刻按新 mode 判断。注：bypass 有 spawn-time flag 锁死限制，
    // SDK 层会静默吞，仍按 fail-secure 处理（应用层比 SDK 严是安全方向）。
    s.permissionMode = mode;
    await s.query.setPermissionMode(mode);
  }

  /** 冷切权限模式 thin delegate。bypass 必须走冷切（spawn-time flag 锁死）。详 restart-controller.ts。 */
  async restartWithPermissionMode(
    sessionId: string,
    mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions',
    handoffPrompt: string,
  ): Promise<string> {
    return this.restartController.restartWithPermissionMode(sessionId, mode, handoffPrompt);
  }

  /** 冷切 OS 沙盒 thin delegate（与 codex restartWithCodexSandbox 字面镜像）。详 restart-controller.ts。 */
  async restartWithClaudeCodeSandbox(
    sessionId: string,
    sandbox: 'off' | 'workspace-write' | 'strict',
    handoffPrompt: string,
  ): Promise<string> {
    return this.restartController.restartWithClaudeCodeSandbox(sessionId, sandbox, handoffPrompt);
  }

  /**
   * CHANGELOG_52 Step 3e：consume 实现迁到 StreamProcessor，class 上保留 protected
   * wrapper 让 sdk-bridge.test.ts 通过 cast 直接调用（与原 protected consume 一致语义）。
   */
  protected consume(
    internal: InternalSession,
    tempKey: string,
    onFirstId: (id: string) => void,
    resumeId?: string,
  ): Promise<string | null> {
    return this.streamProcessor.consume(internal, tempKey, onFirstId, resumeId);
  }
}
