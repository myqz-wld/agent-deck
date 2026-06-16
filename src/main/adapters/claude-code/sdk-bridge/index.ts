import type {
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  PermissionRequest,
  PermissionResponse,
  UploadedAttachmentRef,
  AgentEvent,
  ProviderUsageSnapshot,
} from '@shared/types';
import { eventRepo } from '@main/store/event-repo';
import { summariseSessionForHandOff } from '@main/session/summarizer/llm-runners';
// CHANGELOG_52 Step 3a-3g + CHANGELOG_85 Step 3.2 + Step 4.4：拆 class 完成。本目录（sdk-bridge/）
// 含 14 个 sub-module + 2 子目录（create-session/ + recoverer/） + index.ts (facade)。
//
// **TS module resolution 假设**（F5 finding）：moduleResolution: node 模式下
// `import './sdk-bridge'` 优先匹配 `sdk-bridge.ts` 文件（不存在时才走 `sdk-bridge/index.ts`）。
// Step 3g 删了原 `sdk-bridge.ts` 文件，import 自动切到本 index.ts；外部 import 站点
// （如 `@main/adapters/claude-code/sdk-bridge`）零变更继续工作。
//
// **如果未来切到 node16/bundler module resolution** 此优先级会变（强 ESM 要 explicit
// `/index` 后缀），届时所有 import 站点要加 `/index`。当前 tsconfig.node.json 用 node。
import type {
  InternalSession,
  SdkBridgeOptions,
  SdkSessionHandle,
} from './types';
import { PermissionResponder } from './permission-responder';
import {
  SessionRecoverer,
  defaultResumeJsonlExists,
  defaultResumeJsonlMtimeMs,
  defaultCwdExists,
} from './recoverer';
import { StreamProcessor } from './stream-processor';
import { RestartController } from './restart-controller';
import { runCloseSessionCleanup } from './pending-cancellation';
import { validateSendMessageOrThrow } from './send-validation';
import { createSessionImpl } from './create-session/create-session-impl';
import type { CreateSessionOpts } from './create-session/_deps';
import {
  buildClaudeUsageSnapshot,
  errorUsageSnapshot,
  unavailableUsageSnapshot,
} from '../../provider-usage';
import log from '@main/utils/logger';

const logger = log.scope('claude-bridge');

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
 *
 * **Step 4.4 拆分**（plan deep-project-review-comprehensive-20260528）：原 840 LOC
 * 拆完后本文件作 thin facade（≤ 500 LOC 满足护栏）：
 * - class shell + ctor（11 sub-module ref 装配）
 * - createSession 改 thin delegate → `./create-session/create-session-impl.ts:createSessionImpl`
 * - sendMessage / interrupt / closeSession / setPermissionMode / 2 restartWith* 不拆
 * - 4 protected wrapper（resumeJsonlExists / cwdExists / summariseForHandOff /
 *   listEventsForSession）作 test seam 留 class 内
 * - 6 responder thin wrapper / consume protected wrapper 不拆
 *
 * **decision 矛盾解决记录**（参照 Step 4.1 hand-off-session 同款 decision 范式）：
 * 修前 §保护清单 jsdoc（CHANGELOG_169 F1）标记本文件「下次拆分轮直接跳过」，理由是
 * createSession 主体闭包持 10+ 个跨段共享 ref（tempKey / internal / claudeSandboxMode /
 * claudeModel / realId / opts / releasePending / mcpServers / effectiveResumeCliSid /
 * q / query / runtime / claudeBinary / sandboxOpts），tier-2 抽 sub-method 需打包 args dict
 * 反而降可读性。本 plan §D1 「13 文件全拆 ≤500 LOC」契约 vs §保护清单对立 → user 选
 * 「强行按 mini-spike 拆」方案：子模块间通过函数 return value 传递派生 state（避免单一
 * 巨型 ctx object 闭包污染，保函数式 readability），与 Step 4.1 / 4.2 / 4.3 同款做法。
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
    // **plan restart-controller-jsonl-precheck-20260521 §Step 3g 修法**:
    // ctor 注入 3 个新 thunk (jsonlExistsThunk + summariseFn + listEventsFn) — 与
    // SessionRecoverer 共享同一份 thunk instance,让 helper maybeJsonlFallback 内部
    // jsonl 预检 / LLM 摘要 / events 拉取 走与 recoverer 同款 facade extend override
    // 模式 (test 子类化 facade override protected method)。
    this.restartController = new RestartController({
      recovering: this.recovering,
      emit: opts.emit,
      closeSession: (sid, closeOpts) => this.closeSession(sid, closeOpts),
      createSession: (createOpts) => this.createSession(createOpts).then((h) => h),
      jsonlExistsThunk: (cwd, sid) => this.resumeJsonlExists(cwd, sid),
      jsonlMtimeMsThunk: (cwd, sid) => this.resumeJsonlMtimeMs(cwd, sid),
      summariseFn: (cwd, events) => this.summariseForHandOff(cwd, events),
      listEventsFn: (sid) => this.listEventsForSession(sid),
      // plan resume-inject-raw-messages-20260601 §D5：message-only thunk（与 SessionRecoverer
      // 共享同一 closure），helper injectResumeHistory 拼「最近原始对话消息段」用。
      listMessagesFn: (sid, limit, beforeId) =>
        this.listRecentMessagesForSession(sid, limit, beforeId),
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
    // summariseSessionForHandOff,fallback 路径 helper 调它。
    // **plan restart-controller-jsonl-precheck-20260521 §Step 3g 修法**:
    // 新增 listEventsFn ctor 字段,与 RestartController 共享同一 closure
    // `(sid) => this.listEventsForSession(sid)`,让 helper maybeJsonlFallback 内部
    // events 拉取走同款 facade extend override 模式(test 子类化 facade override
    // listEventsForSession protected method)。
    // **plan resume-inject-raw-messages-20260601 §D5 修法**: 新增 listMessagesFn ctor 字段
    // (末尾),与 RestartController 共享同一 closure,helper injectResumeHistory 拼「最近原始
    // 对话消息段」用(message-only,test 子类化 override listRecentMessagesForSession)。
    this.recoverer = new SessionRecoverer(
      { recovering: this.recovering, emit: opts.emit },
      (createOpts) => this.createSession(createOpts),
      (sid, text, attachments) => this.sendMessage(sid, text, attachments),
      (cwd, sid) => this.resumeJsonlExists(cwd, sid),
      (cwd, sid) => this.resumeJsonlMtimeMs(cwd, sid),
      (cwd) => this.cwdExists(cwd),
      (cwd, events) => this.summariseForHandOff(cwd, events),
      (sid) => this.listEventsForSession(sid),
      (sid, limit, beforeId) => this.listRecentMessagesForSession(sid, limit, beforeId),
    );

    this.streamProcessor = new StreamProcessor({ sessions: this.sessions, emit: opts.emit });
  }

  /** 调整超时阈值。0 = 关闭。只影响新建的 pending；老的保持原 timer。 */
  setPermissionTimeoutMs(ms: number): void {
    this.permissionTimeoutMs = Math.max(0, ms);
  }

  async getUsageSnapshot(): Promise<ProviderUsageSnapshot> {
    const session = [...this.sessions.values()]
      .reverse()
      .find(
        (s) =>
          !s.expectedClose &&
          typeof s.query?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET ===
            'function',
      );
    if (!session) {
      return unavailableUsageSnapshot(
        'claude-code',
        'Claude',
        '先打开一个 Claude 会话后，再查看额度信息',
      );
    }

    try {
      const usage = await session.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
      return buildClaudeUsageSnapshot(usage);
    } catch (err) {
      logger.warn('[claude-bridge] usage snapshot failed:', err);
      return errorUsageSnapshot('claude-code', 'Claude', err);
    }
  }

  /**
   * Step 4.4 拆完后 thin delegate to `createSessionImpl`。详 `./create-session/` 子目录
   * 三子模块（_deps SSOT / create-session-impl orchestrator / create-session-sdk-query）
   * jsdoc：caller 入参签名 / 各 phase 边界 / try/catch 失败 cleanup 不变量保留。
   *
   * **decision 矛盾解决**（参照 Step 4.1 同款）：原 §保护清单 jsdoc 标记本文件不拆，
   * user plan §D1 决策强行拆 → 子模块间通过函数 return value 传递派生 state 避免巨型
   * ctx object 闭包污染（详 class 头部 jsdoc decision 矛盾解决记录）。
   */
  async createSession(opts: CreateSessionOpts): Promise<SdkSessionHandle> {
    const providerEnv = this.opts.envProvider?.();
    const envOverrideExtra =
      providerEnv || opts.envOverrideExtra
        ? { ...(providerEnv ?? {}), ...(opts.envOverrideExtra ?? {}) }
        : undefined;
    const defaultModel = this.opts.defaultModelProvider?.();
    const effectiveOpts: CreateSessionOpts = {
      ...opts,
      ...(envOverrideExtra ? { envOverrideExtra } : {}),
      ...(opts.model === undefined && defaultModel ? { model: defaultModel } : {}),
    };
    return createSessionImpl(effectiveOpts, {
      sessions: this.sessions,
      emit: this.opts.emit,
      streamProcessor: this.streamProcessor,
      responder: this.responder,
      getPermissionTimeoutMs: () => this.permissionTimeoutMs,
      interrupt: (sid) => this.interrupt(sid),
    });
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
      agentId: 'claude-code',
      kind: 'message',
      payload: {
        text,
        role: 'user',
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        // plan handoff-render-and-image-batch-20260521 §不变量 5 严守 + R1 reviewer-claude
        // INFO-1 修法:仅 createSession first user message 携带 handOff metadata(finalizeSessionStart
        // 路径),后续 sendMessage 轮(本 emit)不重复携带 — 防 events 表 hand-off baton 链识别
        // 误把后续轮次也计为新 baton 触发点。与 codex sdk-bridge sendMessage emit 同款语义。
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
   * Claude Code jsonl mtime protected wrapper。
   *
   * read-side 幻影 fork 自愈用它确认 applicationSid.jsonl 没明显落后于 DB lastEventAt；
   * 失败返回 null，helper 会退回 fresh fallback。
   */
  protected resumeJsonlMtimeMs(cwd: string, sessionId: string): number | null {
    return defaultResumeJsonlMtimeMs(cwd, sessionId);
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

  /**
   * **plan restart-controller-jsonl-precheck-20260521 §Step 3g 修法**:
   * events 来源 protected wrapper(同 resumeJsonlExists / cwdExists / summariseForHandOff 模式)。
   *
   * 让 test 通过子类化 override 不依赖真 DB(单测 mock event 序列);实际走 module-level
   * `eventRepo.listForSession(sid)`(默认 limit=200,DESC 排序;`formatEventsForPrompt`
   * 内部已自己 sort ASC + slice(-30) 取最新一段)。
   *
   * RestartController + SessionRecoverer ctor 共享同一份 closure 注入,让 helper
   * `maybeJsonlFallback` 内部 events 拉取 + recoverer 主路径 prependHistorySummary
   * 调用走同款 thunk(避免 recoverer.ts 与 helper 双处 hardcode eventRepo 漂移)。
   */
  protected listEventsForSession(sessionId: string): AgentEvent[] {
    return eventRepo.listForSession(sessionId);
  }

  /**
   * **plan resume-inject-raw-messages-20260601 §D5 message-only test seam**（同
   * listEventsForSession / summariseForHandOff 模式）。
   *
   * 让 test 通过子类化 override 不依赖真 DB（单测 mock message 序列）；实际走 module-level
   * `eventRepo.listRecentMessages(sid, limit, beforeIdInclusive?)`（只取 kind='message' +
   * role∈{user,assistant} + error 非真）。RestartController + SessionRecoverer ctor 共享同一份
   * closure 注入，让 helper `maybeJsonlFallback` 内部「最近原始对话消息段」拉取走同款 thunk
   * （避免双处 hardcode eventRepo 漂移）。
   */
  protected listRecentMessagesForSession(
    sessionId: string,
    limit: number,
    beforeIdInclusive?: number,
  ): (AgentEvent & { id: number })[] {
    return eventRepo.listRecentMessages(sessionId, limit, beforeIdInclusive);
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
      logger.warn(`[sdk-bridge] interrupt failed`, err);
    }
  }

  /**
   * 删会话清理：abort live query + 兜底清 pending timer + 移除 internal session 记录。
   * 与 interrupt 区别：interrupt 允许 resume / 继续同 session；close 是永久关闭，
   * 由 SessionManager.delete 调用，确保 SDK 子进程不继续跑（CHANGELOG_20 / N2）。
   */
  async closeSession(sessionId: string, opts: { markRecentlyDeleted?: boolean } = {}): Promise<void> {
    let key: string | null = null;
    let internal: InternalSession | null = null;
    for (const [k, v] of this.sessions.entries()) {
      if (k === sessionId || v.cliSessionId === sessionId || v.applicationSid === sessionId) {
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
      logger.warn(`[sdk-bridge] interrupt during close failed: ${sessionId}`, err);
    }

    runCloseSessionCleanup({
      sessions: this.sessions,
      internal,
      key,
      sessionId,
      emit: this.opts.emit,
      markRecentlyDeleted: opts.markRecentlyDeleted,
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
    //
    // A1-MED-1 (claude) plan §Phase 3 Step 3.1 修法：SDK setPermissionMode 抛错时回滚
    // in-memory cache（与 restartWithPermissionMode 失败回滚 DB 同款 fail-fast 模式）。
    // 修前：SDK throw → s.permissionMode 已经被改为 mode → caller 收到 throw 但 cache
    // 已脏(canUseTool / sandbox decision 用脏 cache)→ DB / UI / 实际 SDK 行为三不一致。
    //
    // **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase R3 fix-3 修法**（R3 plan-review
    // codex Batch A HIGH-2 升级，替代 Phase 2.7 per-session seq counter）：per-session async
    // lock 串行化 setPermissionMode。
    //
    // **Phase 2.7 per-session seq 残留 race 真根因**（codex A HIGH-2）：
    // 同 session 并发 + 双失败：A: ++seq=1, oldMode='default', s.permissionMode='plan',
    // await 失败 → B: ++seq=2, oldMode='plan'(A optimistic 写入), s.permissionMode='bypass',
    // await 失败 → B catch: seq===2 === B.seq → s.permissionMode = oldMode = 'plan'(A 脏值);
    // A catch: seq===2 !== A.seq(1) → 跳过回滚 → s.permissionMode 保留 'plan'。
    // 最终 cache='plan' 但 SDK 实际仍'default' → canUseTool 按脏 cache 判断 → 安全降级风险。
    //
    // **修法 = chain 串行化**：通过 `s.permissionModeChain` 串行执行 setPermissionMode；
    // 串行化后 oldMode 永远是上次 catch rollback 后的真值（永不读他人 optimistic 写入），
    // catch rollback 是 race-free 的简单 oldMode 还原。
    //
    // **chain 设计**：caller 拿到的 Promise 仍 reject 真错；chain 内部 `.catch(() => undefined)`
    // 吞 throw 让 chain 不被打破（否则一次失败后 chain 永卡 reject）。
    //
    // **plan §Phase 6.3 L1 by-design 时序窗口标注**：optimistic 写 cache 在 await SDK ack 之前
    // 是 by-design fail-secure（详 InternalSession.permissionModeChain jsdoc 完整论述）。
    const prev = s.permissionModeChain ?? Promise.resolve();
    const next = prev.then(async () => {
      const oldMode = s.permissionMode; // 串行化后 oldMode 永远是上次 catch rollback 后的真值
      s.permissionMode = mode; // optimistic
      try {
        await s.query.setPermissionMode(mode);
      } catch (err) {
        s.permissionMode = oldMode; // race-free rollback (chain 串行化保证 oldMode 真值)
        throw err;
      }
    });
    // chain 自身吞 throw 防链路打破，caller 拿到的 next promise 仍 reject 真错给上层
    s.permissionModeChain = next.catch(() => undefined);
    return next;
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
    applicationResumeId?: string,
    effectiveResumeCliSid?: string,
    resumeMode?: 'resume-cli' | 'fresh-cli-reuse-app',
  ): Promise<string | null> {
    return this.streamProcessor.consume(
      internal,
      tempKey,
      onFirstId,
      applicationResumeId,
      effectiveResumeCliSid,
      resumeMode,
    );
  }
}
