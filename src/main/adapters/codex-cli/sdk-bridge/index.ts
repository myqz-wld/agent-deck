import type { Codex } from '@openai/codex-sdk';
import { sessionManager } from '@main/session/manager';
import { loadCodexSdk } from '@main/adapters/codex-cli/sdk-loader';
import { settingsStore } from '@main/store/settings-store';
import { eventRepo } from '@main/store/event-repo';
import { summariseSessionForHandOff } from '@main/session/summarizer';
import {
  buildAgentDeckMcpConfigForCodex,
  mergeCodexConfig,
  AGENT_DECK_MCP_TOKEN_ENV,
} from '@main/codex-config/agent-deck-mcp-injector';
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
// CHANGELOG_52 Step 4a-4c：拆 class 完成。本目录（sdk-bridge/）含 4 sub-module + index.ts (facade)。
//
// **TS module resolution 假设**（与 claude sdk-bridge 同款）：moduleResolution: node
// 模式下 `import './sdk-bridge'` 优先匹配 `sdk-bridge.ts` 文件（不存在时才走 `sdk-bridge/index.ts`）。
// Step 4c 删了原 `sdk-bridge.ts` 文件，import 自动切到本 index.ts；外部 import 站点
// （`@main/adapters/codex-cli/sdk-bridge`）零变更继续工作。
//
// R37 P2-E Step 3.4a：抽 input-pack.ts (packCodexInput + extractAttachmentPaths 模块级纯函数)。
// R37 P2-E Step 3.4b：抽 session-finalize.ts (persistSessionFields 收口 setCodexSandbox + setModel + warn)。
// R37 P2-E Step 3.4c：抽 restart-controller.ts (RestartController sub-class 持冷切 sandbox method)。
import { AGENT_ID, MAX_MESSAGE_LENGTH, MAX_PENDING_MESSAGES } from './constants';
import type {
  CodexBridgeOptions,
  CodexSessionHandle,
  InternalSession,
} from './types';
import { resolveBundledCodexBinary, prependBundledCodexPathDirs } from './codex-binary';
import { ThreadLoop, type ThreadLoopCtx } from './thread-loop';
import { packCodexInput, extractAttachmentPaths } from './input-pack';
import { RestartController, type RestartCtx } from './restart-controller';
import { invalidateCodexInstance } from '@main/adapters/codex-cli/codex-instance-pool';
import type { AgentEvent, UploadedAttachmentRef } from '@shared/types';
import { deleteUploadIfExists } from '@main/store/image-uploads';
import {
  SessionRecoverer,
  defaultCodexResumeJsonlExists,
  defaultCwdExists,
} from './recoverer';
// Phase 4 Step 4.3: createSession 主体抽到 create-session/ 子目录(facade pattern + 3 子段)。
// facade.createSession 改为 thin delegate 调 createSessionImpl orchestrator → validate / resume / new
// 3 子段 fn(详 create-session/_deps.ts 顶部 jsdoc 拆分说明)。
import { createSessionImpl } from './create-session/create-session-impl';
import type { CreateSessionOpts } from './create-session/_deps';
import log from '@main/utils/logger';

const logger = log.scope('codex-bridge');

export type { CodexSessionHandle, CodexBridgeOptions } from './types';

/**
 * 把 process.env 转成 Record<string, string>（过滤 undefined 值），让 codex SDK
 * `new Codex({env})` 能拿到一个全 string 字段的 env 表（plan codex-handoff-team-alignment-20260518
 * P2 Step 2.5b helper）。
 *
 * 背景：Node.js `process.env` 类型是 `Record<string, string | undefined>`，TS 严格模式下
 * 不能直接 spread 到 `Record<string, string>`。codex SDK 0.120.0 type 注释明示「env 传值后
 * 子进程不再继承 process.env」，所以必须手工 spread + 过滤 undefined 拷贝出快照,再叠加
 * per-session AGENT_DECK_MCP_TOKEN（spike 2 §2 codex SDK 内部已用同款过滤逻辑 line 222-234）。
 */
function snapshotProcessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Codex SDK 通道实现。与 claude-code/sdk-bridge.ts 同形态但显著简化：
 *
 * - 无 canUseTool / AskUserQuestion / ExitPlanMode（codex SDK 不支持，capabilities 已 false）
 * - 无 setPermissionMode（同上）
 * - 无 hook 通道时序竞争（codex 无 hook），不调 sessionManager.expectSdkSession
 * - 同一 thread 不能并发 turn（codex CLI 共享 ~/.codex/sessions 文件），用 pendingMessages 串行
 * - interrupt = AbortController.abort() → SIGTERM 子进程；下条消息可继续同 thread
 */
export class CodexSdkBridge {
  /** key = 真实 thread_id（拿到前用 tempKey） */
  private sessions = new Map<string, InternalSession>();
  /**
   * Per-session Codex SDK 实例（plan codex-handoff-team-alignment-20260518 P2 Step 2.5a 字段重组）。
   *
   * 修前 single `private codex: Codex | null` 给所有 codex teammate 共享，子进程 envOverride
   * 复用同一份全局 token，应用层无法区分「这条 MCP 请求来自哪个 codex teammate」（HIGH-1
   * caller_session_id 透传困境）。
   *
   * 修后 per-session Map：每个 codex live session 独立 new Codex({env: {...process.env,
   * AGENT_DECK_MCP_TOKEN: <session-token>}})，token 由 mcpSessionTokenMap.allocate 在
   * createSession 起始时分配（Step 2.5c sid 时序），子进程通过 envOverride 拿到自己的 token，
   * agent-deck MCP server `/mcp` 路由 `request.raw.auth` 反查 token map 得到真正 caller sid。
   *
   * Sub-step 2.5d closeSession 同步 delete entry + release token；Sub-step 2.5e
   * setCodexCliPath 路径变更时 clear 整 Map（已 spawn 的 codex 子进程不受影响 —
   * spike 2 §1 实证 envOverride 已 frozen 拷贝到子进程 env）。
   *
   * `codex-instance-pool.ts` 仅服务 oneshot caller（summarizer-runner / handoff-runner），
   * 不需要 per-session token，沿用全局 process.env 路径，与本 Map 双轨独立维护（plan §M5）。
   */
  private codexBySession: Map<string, Codex> = new Map();
  /**
   * symmetry-plan P2 HIGH-A：与 claude `recovering` Map 同模式 — 单飞 Map 覆盖
   * `restartWithCodexSandbox` 整段副作用窗口（close + DB write + createSession）。
   *
   * 修前并发两次 restartWithCodexSandbox(sid, ...) 可同时进 close → setCodexSandbox（写库
   * 竞争最后写赢）→ 各 createSession resume 一次（双 SDK 子进程同 sid），DB 字段与第二个
   * 进程 actual sandbox 不一致。修后单飞排队执行（后者等前者完成再跑），与 claude
   * `restartWithPermissionMode` / `restartWithClaudeCodeSandbox` 同款保护（REVIEW_36 R2 MED-B）。
   *
   * 未来 HIGH-B codex recoverer 也共享本 Map，与 claude 同模式 facade 持权威 ref（双方 mutate
   * 同一份），同 sessionId 的并发 recoverAndSend / restartWithX 排队执行。
   */
  private recovering = new Map<string, Promise<unknown>>();
  /**
   * CHANGELOG_52 Step 4b：ThreadLoop sub-class 持 startNewThreadAndAwaitId + runTurnLoop。
   * sessions Map / emit 通过 ThreadLoopCtx 注入；class 上 createSession / sendMessage 内的
   * 调用走 this.threadLoop.xxx 委托。
   */
  private threadLoop: ThreadLoop;
  /**
   * R37 P2-E Step 3.4c：RestartController sub-class 持 restartWithCodexSandbox method。
   * ctx 通过 thunk 反调本 facade 的 closeSession + createSession（避免循环引用），
   * facade 端只保留 thin wrapper 委托（与 claude RestartController 同模式）。
   */
  private restartController: RestartController;

  /**
   * symmetry-plan P2 HIGH-B：SessionRecoverer 持 recoverAndSend 主体。
   *
   * ctx 与 RestartController 共享 facade.recovering Map（HIGH-A 已建权威 ref）。
   * thunk 反调 facade.createSession / sendMessage / cwdExists / resumeJsonlExists（test
   * 通过 facade extend override 让单测不依赖真 fs / 真 LLM）。与 claude SessionRecoverer 同模式。
   */
  private recoverer: SessionRecoverer;

  constructor(private opts: CodexBridgeOptions) {
    const ctx: ThreadLoopCtx = {
      sessions: this.sessions,
      emit: opts.emit,
      // P5 Round 1 reviewer-claude MED-1 修法 (resolveWithFallback 漏清 codexBySession + token map):
      // facade 注入 thunk 让 thread-loop 不直接 import codexBySession / mcp-session-token-map 模块。
      // 失败 swallow — fallback 路径已经在错误状态下,cleanup 失败不应再 throw 阻塞 emit 序列(thread-loop
      // resolveWithFallback 内已 catch 本 thunk 的 throw 但仍兜底)。
      cleanupTempKey: (tempKey: string) => {
        try {
          this.codexBySession.delete(tempKey);
        } catch (cleanupErr) {
          logger.warn(
            `[codex-bridge] codexBySession.delete failed in cleanupTempKey for ${tempKey}:`,
            cleanupErr,
          );
        }
        try {
          mcpSessionTokenMap.release(tempKey);
        } catch (cleanupErr) {
          logger.warn(
            `[codex-bridge] mcpSessionTokenMap.release failed in cleanupTempKey for ${tempKey}:`,
            cleanupErr,
          );
        }
      },
    };
    this.threadLoop = new ThreadLoop(ctx);
    const restartCtx: RestartCtx = {
      recovering: this.recovering,
      emit: opts.emit,
      // thunk 反调本 facade 的 closeSession / createSession，避免直接持有 facade ref
      closeSession: (sessionId: string): Promise<void> => this.closeSession(sessionId),
      createSession: (restartOpts) => this.createSession(restartOpts),
      // **REVIEW_101 R1 双方共识合并修法（codex restart 接入 maybeCodexJsonlFallback）**:
      // restart 与 recoverer 共享同一份 jsonl 探测 + 历史注入 thunk instance（对齐 claude RestartCtx）。
      // 让 restartWithCodexSandbox 冷切 sandbox 时 jsonl 缺失走 fresh-cli-reuse-app fallback 而非
      // resumeThread earlyErr 回滚切档失败（修前 codex restart 完全无 jsonl 处理，claude restart 已有）。
      jsonlExistsThunk: (threadId, startedAt) => this.codexResumeJsonlExists(threadId, startedAt),
      summariseFn: (cwd, events) => this.summariseForHandOff(cwd, events),
      listEventsFn: (sid) => this.listEventsForSession(sid),
      listMessagesFn: (sid, limit, beforeId) => this.listRecentMessagesForSession(sid, limit, beforeId),
    };
    this.restartController = new RestartController(restartCtx);

    // symmetry-plan P2 HIGH-B：SessionRecoverer 装配（与 claude facade 同款 thunk 注入模式）。
    // arrow 闭包 this，运行时晚解析 → this.createSession 一定已绑定。
    // attachments 透传 sendMessage 第三参（与 claude HIGH-1 同款 — 避免 inflight 第二条等待者丢图）。
    // **plan resume-inject-raw-messages-20260601 §D5/§D7/§D8（解开 REVIEW_60 F5）**：+3 thunk
    // 让 codex 与 claude 对称走 injectResumeHistory 注入历史。
    // - summariseFn: bind 本类 protected summariseForHandOff（默认 summariseSessionForHandOff
    //   agentName='Agent'，复用 claude oneshot 本地 OAuth；§D8 不为 codex 写平行总结函数）
    // - listEventsFn: bind protected listEventsForSession（eventRepo.listForSession 全量喂总结）
    // - listMessagesFn: bind protected listRecentMessagesForSession（eventRepo.listRecentMessages
    //   message-only 拼原始对话段）
    this.recoverer = new SessionRecoverer(
      { recovering: this.recovering, emit: opts.emit },
      (createOpts) => this.createSession(createOpts),
      (sid, text, attachments) => this.sendMessage(sid, text, attachments),
      (threadId, startedAt) => this.codexResumeJsonlExists(threadId, startedAt),
      (cwd) => this.cwdExists(cwd),
      (cwd, events) => this.summariseForHandOff(cwd, events),
      (sid) => this.listEventsForSession(sid),
      (sid, limit, beforeId) => this.listRecentMessagesForSession(sid, limit, beforeId),
    );
  }

  /**
   * 设置面板「Codex 二进制路径」变更：清掉所有 Codex 实例，下次 createSession 重建。
   *
   * R37 P1 Step 1.2 (G)：删 `private codexCliPath` field — path 实际从 `settingsStore.get('codexCliPath')`
   * 同步读（IPC settingsStore.set 是 setCodexCliPath 的前置步骤），不需要 instance field 镜像；
   * setCodexCliPath 仅作 invalidation hook（清 codexBySession Map 让下次 ensureCodex 重建 + 调 pool
   * invalidate 让两个 oneshot runner 也下次重建）。
   *
   * **plan codex-handoff-team-alignment-20260518 P2 Step 2.5e**：从清单 `this.codex = null`
   * 改成清整 codexBySession Map（per-session 实例字段重组后所有 codex live session 各持一个）。
   * 已 spawn 中的 codex 子进程不受影响（spike 2 §1 实证 envOverride 已 frozen 拷贝到子进程 env，
   * Map 清空只让下次 ensureCodex 重建实例 — 已跑的子进程仍用旧二进制 + 旧 token）。
   *
   * 已存在的 Thread 实例继续用旧 codex 配置（codex 实例只在 spawn 子进程时被读到，旧 thread
   * 下次 runStreamed 时会用旧 path；新建会话才用新 path）。可以接受：用户改 path 通常不需要
   * 立即影响在跑的会话。
   */
  setCodexCliPath(_path: string | null): void {
    // 注意：不再持 instance field，path 实际从 settingsStore.get 读。本方法仅作 invalidation hook
    this.codexBySession.clear();
    // R37 P1 Step 1.2 (G)：同步 invalidate oneshot pool，让 summarizer-runner / handoff-runner
    // 下次 call 也用新 path 重建（修前 3 处独立 cache，path 改要等各自 path 比较 miss 才同步）
    invalidateCodexInstance();
  }

  /**
   * 拿（或新建）指定 session 的 Codex SDK 实例（plan P2 Step 2.5b signature 改造）。
   *
   * 修前 `ensureCodex(): Promise<Codex>` 无参数 + 共享单实例。修后 `(sessionId, sessionToken)`
   * 双参数 + per-session Map cache：命中 return；未命中 new Codex 时 envOverride 注入
   * `{...process.env, AGENT_DECK_MCP_TOKEN: sessionToken}` — codex SDK type 注释明示
   * 「When provided, the SDK will not inherit variables from process.env」，所以必须手工
   * spread `process.env`（snapshotProcessEnv 过滤 undefined 值）让 codex CLI 子进程仍能拿到
   * PATH / HOME 等基础 env，再加上 per-session token。
   *
   * **plan codex-handoff-team-alignment-20260518 §P3 Step 3.5 + §D1 ADR §(c) 升级**:
   * 第 3 参数 `envOverrideExtra` 让 caller (createSession) 透传额外 env 字段(generic 透传
   * 机制,目前无 hot caller — reviewer-claude wrapper 路径已改 cross-adapter native 删除;
   * 字段保留供未来 caller 重用)。merge 顺序 = `snapshotProcessEnv()` > `AGENT_DECK_MCP_TOKEN`
   * > `envOverrideExtra` —— extra 字段在最末，优先级最高（如 caller 真要覆盖某个全局 env
   * 字段也允许）。
   *
   * Map 命中后**不**校验 token 一致性 — caller（createSession）保证 sessionId 内 token 不变
   * （Step 2.5c sid 时序：allocate 一次后 token frozen 直到 close）。**Map 命中也不重新 merge
   * envOverrideExtra**（同 token frozen 语义；envOverrideExtra 在 Codex 实例 lifetime 内
   * frozen 拷贝到子进程 env，spike 2 §1 实证）。
   */
  private async ensureCodex(
    sessionId: string,
    sessionToken: string,
    envOverrideExtra?: Readonly<Record<string, string>>,
  ): Promise<Codex> {
    const cached = this.codexBySession.get(sessionId);
    if (cached) return cached;
    const sdk = await loadCodexSdk();
    // 优先级：用户在设置面板填的 codexCliPath（可指向自装版本）> 打包后内置的 unpacked 二进制
    // > SDK 自己 resolve（dev 模式正常，打包后会拼出 app.asar 内路径导致 spawn ENOTDIR，见
    // resolveBundledCodexBinary 注释）
    // R37 P1 Step 1.2 (G)：直接 settingsStore.get（删 private codexCliPath field）
    const codexCliPath = settingsStore.get('codexCliPath');
    const userCodexPath = codexCliPath && codexCliPath.trim();
    const overridePath = userCodexPath || resolveBundledCodexBinary();
    // CHANGELOG_<X> R2 / B'4 + R1.A5 + R1.D7：自动注入 agent-deck MCP server 配置
    // 给 codex SDK，让 codex CLI 子进程 spawn 时通过 --config mcp_servers.agent-deck.url=...
    // 连接到本应用 HookServer /mcp 路由（HTTP transport）。bearer token 走 env var
    // 间接引用（AGENT_DECK_MCP_TOKEN 由本 ensureCodex 通过 envOverride 注入子进程,plan P2 Step 2.5b
    // per-session 路径替代修前 main bootstrap 设全局 process.env 路径）。
    // 不满足注入条件（设置 OFF / hookServer 未启 / token 未生成）→ 返回 null，
    // codex 不挂 agent-deck server（其他用户手配 mcp_servers 段不受影响，走 ~/.codex/config.toml 持久化）
    const settings = settingsStore.getAll();
    const agentDeckMcpConfig = buildAgentDeckMcpConfigForCodex(settings, this.opts.hookServer ?? null);
    const codexConfig = mergeCodexConfig(null, agentDeckMcpConfig);
    if (agentDeckMcpConfig) {
      logger.info(`[codex-bridge] agent-deck MCP server config injected (HTTP transport, sid=${sessionId})`);
    }
    // codex SDK 0.120.0 type 注释:env 传值后子进程不再继承 process.env(spike 2 §2 line 222-234
    // 实证 envOverride 优先 + 绕过 process.env fallback)。所以必须手工 spread process.env 过滤
    // undefined 值,再叠加 per-session AGENT_DECK_MCP_TOKEN 让子进程拿到完整 env。
    //
    // plan §P3 Step 3.5 + §D1 ADR §(c) 升级: caller 透传的 envOverrideExtra（generic 透传机制,
    // 目前无 hot caller）merge 到末尾，优先级最高（允许覆盖全局 env 字段）。
    const envOverride: Record<string, string> = snapshotProcessEnv();
    envOverride[AGENT_DECK_MCP_TOKEN_ENV] = sessionToken;
    if (envOverrideExtra) {
      Object.assign(envOverride, envOverrideExtra);
    }
    // codexPathOverride 短路 SDK 自身 resolve → SDK pathDirs 置空，不再注入 bundled rg helper PATH。
    // 仅当走的是 bundled 二进制（非用户自填 codexCliPath）时补回（用户自装 codex 自带 PATH 解析，
    // 不该被我们的 bundled helper 污染）。dev / 无 bundled helper → no-op。
    if (overridePath && !userCodexPath) {
      prependBundledCodexPathDirs(envOverride);
    }
    const codex = new sdk.Codex({
      ...(overridePath ? { codexPathOverride: overridePath } : {}),
      ...(codexConfig ? { config: codexConfig } : {}),
      env: envOverride,
    });
    this.codexBySession.set(sessionId, codex);
    return codex;
  }

  /**
   * 把指定 session 的 Codex 实例 Map key 从 oldId 改到 newId（plan P2 Step 2.5 Sub-step 2.5d
   * 同款语义,plan §不变量 7 / Step 2.8 调用入口）。
   *
   * 调用契约：必须由 `sessionManager.renameSdkSession` 函数体统一调（Step 2.8 接入），不允许
   * 散调（thread-loop / sdk-bridge recoverer 各自调会漏一处）。token map 同步 rename 由
   * sessionManager 统一管，本 method 只动 codexBySession Map。
   *
   * 边角处理:
   * - oldId 不在 Map(claude adapter / 已 release / never allocated)→ 静默 no-op
   * - newId 已经在 Map(理论不应发生:rename 前 newId 是新 thread id 不可能 already-allocated)
   *   → 仍 no-op,保留 newId 现 entry,不覆盖(防丢已 spawn 子进程引用)
   */
  renameCodexInstance(oldId: string, newId: string): void {
    const codex = this.codexBySession.get(oldId);
    if (codex === undefined) return;
    if (this.codexBySession.has(newId)) return;
    this.codexBySession.delete(oldId);
    this.codexBySession.set(newId, codex);
  }

  async createSession(opts: CreateSessionOpts): Promise<CodexSessionHandle> {
    // Phase 4 Step 4.3 — facade thin delegate (详 create-session/_deps.ts §拆分布局)。
    // 字段 jsdoc SSOT 在 CreateSessionOpts interface(create-session/_deps.ts);
    // method 主体抽到 createSessionImpl orchestrator → validate / resume / new 3 子段。
    return createSessionImpl(opts, {
      sessions: this.sessions,
      codexBySession: this.codexBySession,
      threadLoop: this.threadLoop,
      emit: this.opts.emit,
      // arrow 闭包 facade `this`,运行时晚解析 → this.ensureCodex 一定已绑定
      ensureCodex: (sid, token, extra) => this.ensureCodex(sid, token, extra),
    });
  }

  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
  ): Promise<void> {
    const s = this.sessions.get(sessionId);
    // symmetry-plan P2 HIGH-B：sessions Map 缺该 sessionId → 走 recoverer 自愈（与 claude
    // sdk-bridge/index.ts:332 同款）。修前直接 throw 让用户在 app 重启 / dev mode vite hot reload
    // / main process crash 重生场景下不可恢复（必须新建会话丢上下文）。
    //
    // plan cross-adapter-parity-20260515 Phase B Step B.3:recoverAndSend signature 改
    // Promise<string>(返 finalId)。本 caller(codex bridge sendMessage)**不消费**返回值 —
    // 但 recoverAndSend 内部 inflight 等待者 path 通过 `await inflight` 拿同款 finalId 调
    // sendThunk → bridge.sendMessage(finalId, ...) 不再撞 OLD sid not found(REVIEW_40 R2
    // reviewer-codex MED parity 限制治法,plan §B 主体)。
    if (!s) {
      await this.recoverer.recoverAndSend(sessionId, text, attachments);
      return;
    }

    // REVIEW_24 HIGH-2 follow-up：MAX_MESSAGE_LENGTH 算 text 字符（与 messageRepo cap
    // 全局对齐）。attachments 总大小由 IPC 层独立 30MB 校验，sdk-bridge 这层只管 text。
    const len = text.length;
    if (len > MAX_MESSAGE_LENGTH) {
      throw new Error(
        `单条消息 ${len.toLocaleString()} 字符超过 ${MAX_MESSAGE_LENGTH.toLocaleString()} 字符上限。请精简或拆分发送。`,
      );
    }

    if (s.pendingMessages.length >= MAX_PENDING_MESSAGES) {
      throw new Error(
        `待发送队列已堆积 ${MAX_PENDING_MESSAGES} 条。请等当前 turn 跑完再继续发送。`,
      );
    }

    s.pendingMessages.push(packCodexInput(text, attachments));
    this.opts.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: {
        text,
        role: 'user',
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        // plan handoff-render-and-image-batch-20260521 §不变量 5 严守 + R1 reviewer-claude
        // INFO-1 修法:仅 createSession first user message 携带 handOff metadata,后续 sendMessage
        // 轮(本 emit)不重复携带 — 防 events 表 hand-off baton 链识别误把后续轮次也计为新 baton
        // 触发点;handler 契约语义「hand-off 仅 cold-start 一次」严守。
      },
      ts: Date.now(),
      source: 'sdk',
    });

    // 触发 turn loop（如果当前没在跑就启）
    if (!s.turnLoopRunning) {
      void this.threadLoop.runTurnLoop(s, sessionId);
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s?.currentTurn) return;
    try {
      s.currentTurn.abort();
    } catch (err) {
      logger.warn(`[codex-bridge] interrupt failed`, err);
    }
  }

  /**
   * 冷切 codex sandbox 档位（CHANGELOG_<X> A2b）：销毁旧 thread + 用新 sandbox resume 重建。
   *
   * R37 P2-E Step 3.4c：实现下沉到 RestartController sub-class（与 claude restart-controller 同模式）。
   * 本 facade method 仅 thin wrapper 委托给 restartController.restartWithCodexSandbox(...)。
   * 行为零变化：emit / close / DB write / createSession resume / rename 防御 / 回滚序列字面一致。
   */
  async restartWithCodexSandbox(
    sessionId: string,
    sandbox: 'workspace-write' | 'read-only' | 'danger-full-access',
    handoffPrompt: string,
  ): Promise<string> {
    return this.restartController.restartWithCodexSandbox(sessionId, sandbox, handoffPrompt);
  }

  /**
   * 删会话清理：abort 当前 turn + 清 pendingMessages + 移除 internal session 记录。
   * 由 SessionManager.delete 调用，确保 codex 子进程不继续跑（CHANGELOG_20 / N2）。
   *
   * REVIEW_4 H1：必须先设 `intentionallyClosed = true` 再 abort，让 runTurnLoop catch
   * 看到标记后**静默退出**（不发 finished/message）。否则 abort 触发 catch → emit
   * `finished{subtype:interrupted}` → manager.dedupOrClaim 不丢这条 sdk 事件 →
   * ensureRecord 把已删 session 复活成 lifecycle:active 的幽灵 record + 多通知一条「Agent 完成」。
   */
  async closeSession(sessionId: string): Promise<void> {
    const internal = this.sessions.get(sessionId);
    if (!internal) return;

    // 关键：标记必须在 abort 之前置位，否则 runTurnLoop 的 catch 微任务会先看到 aborted 跑常规分支
    internal.intentionallyClosed = true;

    if (internal.currentTurn) {
      try {
        internal.currentTurn.abort();
      } catch (err) {
        logger.warn(`[codex-bridge] abort during close failed: ${sessionId}`, err);
      }
      internal.currentTurn = null;
    }

    // 清残余待发消息：close 后不应再 resume 这个 session，pending 不再有意义。
    // MED 修法：未消费的 attachments 文件 fire-and-forget unlink，减少孤儿（reaper 14 天兜底）
    const orphanPaths: string[] = [];
    for (const input of internal.pendingMessages) {
      orphanPaths.push(...extractAttachmentPaths(input));
    }
    internal.pendingMessages.length = 0;
    if (orphanPaths.length > 0) {
      // best-effort 异步删，失败 swallow（reaper 兜底）
      void Promise.all(orphanPaths.map((p) => deleteUploadIfExists(p))).catch(() => {
        /* swallow */
      });
    }

    this.sessions.delete(sessionId);
    sessionManager.releaseSdkClaim(sessionId);
    if (internal.threadId && internal.threadId !== sessionId) {
      sessionManager.releaseSdkClaim(internal.threadId);
    }

    // plan codex-handoff-team-alignment-20260518 P2 Sub-step 2.5d：清 per-session
    // codexBySession Map entry + 释放 token map entry。覆盖两个 key:sessionId 与 internal.threadId
    // 不一致时(例如新建路径 thread-loop firstId 拿到 realId !== tempKey 的瞬间已经 rename 过
    // codexBySession + token map,这里 sessionId == realId / threadId == realId 同款,只命中一次
    // 不会双删;但保险起见两条都跑同款 noop 边角)。
    this.codexBySession.delete(sessionId);
    mcpSessionTokenMap.release(sessionId);
    if (internal.threadId && internal.threadId !== sessionId) {
      this.codexBySession.delete(internal.threadId);
      mcpSessionTokenMap.release(internal.threadId);
    }
  }

  /**
   * Codex 没有 SDK 层 pending 概念（无权限请求 / 无主动提问 / 无 plan mode），
   * 但 IPC handler 期望 listPending 返回结构化对象。返回空数组保持接口一致。
   */
  listPending(_sessionId: string): {
    permissions: never[];
    askQuestions: never[];
    exitPlanModes: never[];
  } {
    return { permissions: [], askQuestions: [], exitPlanModes: [] };
  }

  listAllPending(): Record<
    string,
    { permissions: never[]; askQuestions: never[]; exitPlanModes: never[] }
  > {
    return {};
  }

  /**
   * symmetry-plan P2 HIGH-B：codex jsonl 预检 protected wrapper（与 claude
   * `resumeJsonlExists` 同款 facade extend override 模式）。
   *
   * 让 test 通过子类化 override 不依赖真 ~/.codex/sessions 目录；实际走 module-level
   * `defaultCodexResumeJsonlExists`（扫 startedAt 日期目录 + ±1 day 找 *-<threadId>.jsonl）。
   *
   * recoverer 拿这个判定 codex CLI resume 用的 jsonl 是否还在；不在时走 fallback 路径
   * （createSession 不带 resume + 后置 renameSdkSession 把应用层 events / file_changes /
   * summaries 子表迁过去）。
   */
  protected codexResumeJsonlExists(threadId: string, startedAt: number): boolean {
    return defaultCodexResumeJsonlExists(threadId, startedAt);
  }

  /**
   * symmetry-plan P2 LOW-A：cwd 存在性 protected wrapper（与 claude `cwdExists` 同款）。
   *
   * 让 test 通过子类化 override 不依赖真 fs；实际走 module-level `defaultCwdExists`
   * （直接 existsSync，异常 fail-safe 退化返回 true 让 SDK 自己 try）。
   *
   * recoverer 拿这个判定 sessionRepo.cwd 是否还有效；不存在时走 `findFallbackCwd` 启发式
   * fallback 路径（典型：K2 老 session cwd=worktree 后 worktree 被 archive_plan 删 /
   * 用户手动 git worktree remove / 跨设备同步丢目录）。
   */
  protected cwdExists(cwd: string): boolean {
    return defaultCwdExists(cwd);
  }

  /**
   * **plan resume-inject-raw-messages-20260601 §D8 test seam**（同 cwdExists / codexResumeJsonlExists
   * 模式）。codex jsonl-missing fallback 起 fresh thread 前生成 LLM 总结 prepend（解开 REVIEW_60 F5）。
   *
   * 复用 claude oneshot `summariseSessionForHandOff`（本地 OAuth，Claude 侧 4 节结构化），传
   * **agentName='Agent'**（§D8：让 codex 会话总结不自称「Claude 会话」，buildHandoffPrompt 按此分支
   * intro + 主体 `${a}` 替换）。不为 codex 写平行总结函数 —— 解开「codex SDK 4 节模板 reasoning
   * effort 签名差异」的历史耦合。失败语义见 SummariseFnThunk type jsdoc。
   *
   * test 通过子类化 override 不调真 LLM（撞 OAuth / 计费 / DB 未 init）。
   */
  protected summariseForHandOff(cwd: string, events: AgentEvent[]): Promise<string | null> {
    return summariseSessionForHandOff(cwd, events, 'Agent');
  }

  /**
   * **plan resume-inject §D7 test seam**：全量 events 来源（喂 summariseForHandOff 出 4 节结构）。
   * 实际走 module-level `eventRepo.listForSession`（默认 limit=200，DESC；formatEventsForPrompt
   * 内部自己 sort ASC + slice 取最新）。test 子类化 override 不依赖真 DB。
   */
  protected listEventsForSession(sessionId: string): AgentEvent[] {
    return eventRepo.listForSession(sessionId);
  }

  /**
   * **plan resume-inject §D5 test seam**：message-only 来源（拼「最近原始对话消息段」）。
   * 实际走 module-level `eventRepo.listRecentMessages`（kind='message' + role∈{user,assistant} +
   * error 非真）。test 子类化 override 不依赖真 DB。
   */
  protected listRecentMessagesForSession(
    sessionId: string,
    limit: number,
    beforeIdInclusive?: number,
  ): (AgentEvent & { id: number })[] {
    return eventRepo.listRecentMessages(sessionId, limit, beforeIdInclusive);
  }
}
