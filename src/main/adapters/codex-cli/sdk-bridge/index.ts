import { randomUUID } from 'node:crypto';
import type { Codex, Thread } from '@openai/codex-sdk';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { loadCodexSdk } from '@main/adapters/codex-cli/sdk-loader';
import { settingsStore } from '@main/store/settings-store';
import { resolveSpawnCwd } from '@main/utils/cwd-resolver';
import {
  buildAgentDeckMcpConfigForCodex,
  mergeCodexConfig,
} from '@main/codex-config/agent-deck-mcp-injector';
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
import { AGENT_ID, MAX_MESSAGE_LENGTH, MAX_PENDING_MESSAGES, THREAD_STARTED_FALLBACK_MS } from './constants';
import type {
  CodexBridgeOptions,
  CodexSessionHandle,
  InternalSession,
} from './types';
import { resolveBundledCodexBinary } from './codex-binary';
import { ThreadLoop, type ThreadLoopCtx } from './thread-loop';
import { packCodexInput, extractAttachmentPaths } from './input-pack';
import { persistSessionFields } from './session-finalize';
import { RestartController, type RestartCtx } from './restart-controller';
import { invalidateCodexInstance } from '@main/adapters/codex-cli/codex-instance-pool';
import type { UploadedAttachmentRef } from '@shared/types';
import { deleteUploadIfExists } from '@main/store/image-uploads';
import {
  SessionRecoverer,
  defaultCodexResumeJsonlExists,
  defaultCwdExists,
} from './recoverer';

export type { CodexSessionHandle, CodexBridgeOptions } from './types';

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
  private codex: Codex | null = null;
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
    };
    this.threadLoop = new ThreadLoop(ctx);
    const restartCtx: RestartCtx = {
      recovering: this.recovering,
      emit: opts.emit,
      // thunk 反调本 facade 的 closeSession / createSession，避免直接持有 facade ref
      closeSession: (sessionId: string): Promise<void> => this.closeSession(sessionId),
      createSession: (restartOpts) => this.createSession(restartOpts),
    };
    this.restartController = new RestartController(restartCtx);

    // symmetry-plan P2 HIGH-B：SessionRecoverer 装配（与 claude facade 同款 thunk 注入模式）。
    // arrow 闭包 this，运行时晚解析 → this.createSession 一定已绑定。
    // attachments 透传 sendMessage 第三参（与 claude HIGH-1 同款 — 避免 inflight 第二条等待者丢图）。
    this.recoverer = new SessionRecoverer(
      { recovering: this.recovering, emit: opts.emit },
      (createOpts) => this.createSession(createOpts),
      (sid, text, attachments) => this.sendMessage(sid, text, attachments),
      (threadId, startedAt) => this.codexResumeJsonlExists(threadId, startedAt),
      (cwd) => this.cwdExists(cwd),
    );
  }

  /**
   * 设置面板「Codex 二进制路径」变更：清掉 Codex 实例，下次 createSession 重建。
   *
   * R37 P1 Step 1.2 (G)：删 `private codexCliPath` field — path 实际从 `settingsStore.get('codexCliPath')`
   * 同步读（IPC settingsStore.set 是 setCodexCliPath 的前置步骤），不需要 instance field 镜像；
   * setCodexCliPath 仅作 invalidation hook（清 this.codex 让下次 ensureCodex 重建 + 调 pool
   * invalidate 让两个 oneshot runner 也下次重建）。
   *
   * 已存在的 Thread 实例继续用旧 codex 配置（codex 实例只在 spawn 子进程时被读到，旧 thread
   * 下次 runStreamed 时会用旧 path；新建会话才用新 path）。可以接受：用户改 path 通常不需要
   * 立即影响在跑的会话。
   */
  setCodexCliPath(_path: string | null): void {
    // 注意：不再持 instance field，path 实际从 settingsStore.get 读。本方法仅作 invalidation hook
    this.codex = null;
    // R37 P1 Step 1.2 (G)：同步 invalidate oneshot pool，让 summarizer-runner / handoff-runner
    // 下次 call 也用新 path 重建（修前 3 处独立 cache，path 改要等各自 path 比较 miss 才同步）
    invalidateCodexInstance();
  }

  private async ensureCodex(): Promise<Codex> {
    if (this.codex) return this.codex;
    const sdk = await loadCodexSdk();
    // 优先级：用户在设置面板填的 codexCliPath（可指向自装版本）> 打包后内置的 unpacked 二进制
    // > SDK 自己 resolve（dev 模式正常，打包后会拼出 app.asar 内路径导致 spawn ENOTDIR，见
    // resolveBundledCodexBinary 注释）
    // R37 P1 Step 1.2 (G)：直接 settingsStore.get（删 private codexCliPath field）
    const codexCliPath = settingsStore.get('codexCliPath');
    const overridePath = (codexCliPath && codexCliPath.trim()) || resolveBundledCodexBinary();
    // CHANGELOG_<X> R2 / B'4 + R1.A5 + R1.D7：自动注入 agent-deck MCP server 配置
    // 给 codex SDK，让 codex CLI 子进程 spawn 时通过 --config mcp_servers.agent-deck.url=...
    // 连接到本应用 HookServer /mcp 路由（HTTP transport）。bearer token 走 env var
    // 间接引用（AGENT_DECK_MCP_TOKEN 由 main bootstrap 设进 process.env，子进程继承）。
    // 不满足注入条件（设置 OFF / hookServer 未启 / token 未生成）→ 返回 null，
    // codex 不挂 agent-deck server（其他用户手配 mcp_servers 段不受影响，走 ~/.codex/config.toml 持久化）
    const settings = settingsStore.getAll();
    const agentDeckMcpConfig = buildAgentDeckMcpConfigForCodex(settings, this.opts.hookServer ?? null);
    const codexConfig = mergeCodexConfig(null, agentDeckMcpConfig);
    if (agentDeckMcpConfig) {
      console.log('[codex-bridge] agent-deck MCP server config injected (HTTP transport)');
    }
    this.codex = new sdk.Codex({
      ...(overridePath ? { codexPathOverride: overridePath } : {}),
      ...(codexConfig ? { config: codexConfig } : {}),
    });
    return this.codex;
  }

  async createSession(opts: {
    cwd: string;
    prompt?: string;
    /** 传 thread_id 表示恢复历史会话；codex 从 ~/.codex/sessions/<id>.jsonl 重放 */
    resume?: string;
    /** 首条 user message 的图片附件（IPC 层已落盘到 <userData>/image-uploads/） */
    attachments?: UploadedAttachmentRef[];
    /** 见 types.ts CreateSessionOptions.codexSandbox（per-session 覆盖）。 */
    codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
    /**
     * plan model-wiring-and-handoff-20260514 Step 2.5：spawn handler 解 agent body frontmatter
     * `model` 字段后传入。codex SDK startThread / resumeThread **不接受 per-thread model
     * override**（model 由 ~/.codex/config.toml 顶层 `model` 字段决定），所以本字段：
     * - 仅 setModel 持久化（让 UI / sessions detail 看到 frontmatter 设的 model）
     * - 配合 console.warn 提示用户改 toml 才能真正生效
     *
     * runtime 不影响 codex 实际跑的 model（详 plan D5 / 上方 import comments）。
     */
    model?: string;
  }): Promise<CodexSessionHandle> {
    if (!opts.prompt || !opts.prompt.trim()) {
      throw new Error('首条消息不能为空：codex SDK 需要至少一条 prompt 才能启动 turn');
    }
    // REVIEW_4 M4：首条 prompt 也走 MAX_MESSAGE_LENGTH 上限。原版只 sendMessage 校验，
    // pendingMessages: [opts.prompt] 直接进队列，让 cli.ts / 其他入口可绕过 cap。
    // attachments 不算 text length（IPC 层 30MB 总附件独立校验）
    // REVIEW_24 HIGH-2 follow-up：byteLength → length 与 messageRepo cap 全局对齐
    const promptLen = opts.prompt.length;
    if (promptLen > MAX_MESSAGE_LENGTH) {
      throw new Error(
        `首条 prompt 超出 ${MAX_MESSAGE_LENGTH.toLocaleString()} 字符上限（实际 ${promptLen.toLocaleString()} 字符）`,
      );
    }

    const codex = await this.ensureCodex();
    const cwd = resolveSpawnCwd(opts);
    // CHANGELOG_<X> A2a：codexSandbox 优先级（高 → 低）：
    // 1. opts.codexSandbox（NewSessionDialog / IPC / cli.ts 显式传入，最新意图）
    // 2. resume 路径下 sessionRepo.get(resume).codexSandbox（用户上次该会话选过的，重启应用后回放）
    // 3. settingsStore.get('codexSandbox')（settings 全局值兜底）
    //
    // symmetry-plan P2 MED-B：从 `bridge.currentSandboxMode` field 改为直接 settingsStore 读
    // — 与 claude-code adapter sandbox-resolve.ts 同款直读模式（删 in-memory mirror + setter
    // + apply hook 三层冗余）。settings 改 codexSandbox 不需 push 到 bridge,下次 createSession
    // 即按新值生效（与 claude 同款语义,spawn-time 锁定不变）。
    const persistedSandbox = opts.resume
      ? (sessionRepo.get(opts.resume)?.codexSandbox ?? null)
      : null;
    const sandboxMode = opts.codexSandbox ?? persistedSandbox ?? settingsStore.get('codexSandbox');

    let thread: Thread;
    if (opts.resume) {
      // CHANGELOG_<X> A2a：resume 路径必须透传 sandboxMode / workingDirectory / approvalPolicy，
      // 否则 codex SDK 默认行为 = 不传 --sandbox flag，让 codex CLI 用 ~/.codex/config.toml 全局
      // 默认 / read-only 兜底，丢失用户上次该会话选过的档位（spike-A2 实测验证 SDK
      // resumeThread(id, options) 透传到每次 turn 的 CLI args）。
      thread = codex.resumeThread(opts.resume, {
        workingDirectory: cwd,
        sandboxMode,
        approvalPolicy: 'never',
        skipGitRepoCheck: true,
      });
    } else {
      thread = codex.startThread({
        workingDirectory: cwd,
        sandboxMode,
        approvalPolicy: 'never',
        skipGitRepoCheck: true,
      });
    }

    const firstInput = packCodexInput(opts.prompt, opts.attachments);
    const internal: InternalSession = {
      threadId: opts.resume ?? null,
      cwd,
      thread,
      pendingMessages: [firstInput],
      currentTurn: null,
      turnLoopRunning: false,
      intentionallyClosed: false,
    };

    if (opts.resume) {
      // resume 路径：thread_id 已知，直接登记
      this.sessions.set(opts.resume, internal);
      sessionManager.claimAsSdk(opts.resume);
      this.opts.emit({
        sessionId: opts.resume,
        agentId: AGENT_ID,
        kind: 'session-start',
        payload: { cwd, source: 'sdk' },
        ts: Date.now(),
        source: 'sdk',
      });
      // CHANGELOG_<X> A2a：emit session-start 是同步派发到 sessionManager.ingest →
      // sessionRepo.upsert 创建 record（如果不存在）；之后调 setCodexSandbox UPDATE 字段。
      // 后续 advanceState 内 spread record 时会带上最新 codex_sandbox 不会被静默重置。
      // R37 P2-E Step 3.4b：setSandbox + setModel + warn 收口到 persistSessionFields helper。
      persistSessionFields({ sessionId: opts.resume, sandboxMode, model: opts.model });
      this.opts.emit({
        sessionId: opts.resume,
        agentId: AGENT_ID,
        kind: 'message',
        payload: {
          text: opts.prompt,
          role: 'user',
          ...(opts.attachments && opts.attachments.length > 0
            ? { attachments: opts.attachments }
            : {}),
        },
        ts: Date.now(),
        source: 'sdk',
      });
      // symmetry-plan P2 MED-D：await 首条 thread.started OR earlyError OR 30s timeout 才 return,
      // 让外层 createSession await 真的等待 SDK 实际状态(与 claude waitForRealSessionId 同款语义)。
      //
      // 修前问题（reviewer-claude rebuttal 反驳点 2/3 + lead 实证）：
      // - resume path 直接 `void runTurnLoop` + `return { sessionId: opts.resume }` 立即返回,
      //   restart-controller catch 在 resume path 实际死代码（runTurnLoop earlyErr 路径
      //   `else if (earlyErrCb)` 默认 undefined → emit error 自己处理,createSession 已 resolve）
      // - thread-loop:212 `&& !internal.threadId` 保护让 resume 路径跳过 thread.started.thread_id
      //   校验 → 即使 SDK 真返新 id,application layer 完全感知不到（latent silent split,future-proof
      //   防 SDK 升级 / CLI 行为变更）
      //
      // 修法：仿 startNewThreadAndAwaitId Promise 模式 + onFirstId/onEarlyError 回调:
      // - onFirstId 触发 → resolve 实际 id（thread-loop 已处理 rename 同 / 不同 id 三种情况）
      // - onEarlyError 触发 → emit finished 完成 UI 序列 + reject 让 outer (restart-controller /
      //   recoverer / ipc) catch 触发上下文相关错误处理 (如 DB rollback)
      // - 30s timeout → 退化 resolve(opts.resume) 假定 SDK 慢但能起,与新路径 resolveWithFallback
      //   不同（new 路径需 emit error + finished 完整序列；resume 已 emit session-start + user msg
      //   只缺 thread.started 后续事件,不应武断标 finished:error）
      const resumedId = await new Promise<string>((resolve, reject) => {
        let resolved = false;
        const fallback = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          console.warn(
            `[codex-bridge] resume ${opts.resume} no thread.started in ${THREAD_STARTED_FALLBACK_MS}ms, ` +
              `returning original id (turn loop may still recover)`,
          );
          resolve(opts.resume!);
        }, THREAD_STARTED_FALLBACK_MS);

        void this.threadLoop.runTurnLoop(
          internal,
          opts.resume!,
          (realId) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(fallback);
            // realId 可能 = opts.resume(common case)或新 id(thread-loop 已 rename Map key + 调
            // renameSdkSession + update internal.threadId,outer 仅取最终 id 即可)
            resolve(realId);
          },
          (earlyErr) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(fallback);
            // resume 路径已 emit session-start + user msg,补 finished 完成 UI 序列。
            // **不 emit error message** — 让 outer caller (restart-controller catch / recoverer
            // catch / ipc handler) 自己 emit 上下文相关错误消息,避免双错误消息。
            this.opts.emit({
              sessionId: opts.resume!,
              agentId: AGENT_ID,
              kind: 'finished',
              payload: { ok: false, subtype: 'error' },
              ts: Date.now(),
              source: 'sdk',
            });
            reject(new Error(`Codex resume early error: ${earlyErr}`));
          },
        );
      });
      return { sessionId: resumedId };
    }

    // 新建路径：先用 tempKey 占位，等 thread.started 事件拿到 realId 后 rename
    const tempKey = randomUUID();
    this.sessions.set(tempKey, internal);
    const realId = await this.threadLoop.startNewThreadAndAwaitId(
      internal,
      tempKey,
      cwd,
      opts.prompt,
      opts.attachments,
    );

    // CHANGELOG_<X> A2a：新建路径拿到 realId 后持久化 sandboxMode + model。
    // startNewThreadAndAwaitId 内部已 emit session-start（同步派发 → ingest 创建 record），
    // 此处 persistSessionFields 紧跟 await 之后跑，UPDATE 必然命中。
    // R37 P2-E Step 3.4b：与 resume 路径同款收口（差异仅 sessionId 来源 = realId vs opts.resume）。
    persistSessionFields({ sessionId: realId, sandboxMode, model: opts.model });

    return { sessionId: realId };
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
      console.warn(`[codex-bridge] interrupt failed`, err);
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
        console.warn(`[codex-bridge] abort during close failed: ${sessionId}`, err);
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
}
