import { randomUUID } from 'node:crypto';
import type { Codex, Input, Thread, UserInput } from '@openai/codex-sdk';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { loadCodexSdk } from '@main/adapters/codex-cli/sdk-loader';
import { settingsStore } from '@main/store/settings-store';
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
import { AGENT_ID, MAX_MESSAGE_LENGTH, MAX_PENDING_MESSAGES } from './constants';
import type {
  CodexBridgeOptions,
  CodexSessionHandle,
  InternalSession,
} from './types';
import { resolveBundledCodexBinary } from './codex-binary';
import { ThreadLoop, type ThreadLoopCtx } from './thread-loop';
import type { UploadedAttachmentRef } from '@shared/types';
import { deleteUploadIfExists } from '@main/store/image-uploads';

export type { CodexSessionHandle, CodexBridgeOptions } from './types';

/**
 * 把 (text, attachments) 包成 codex SDK 接受的 Input 形态。
 *
 * - 纯文本：直接返回 string（与原行为字节级一致）
 * - 带 attachments：返回 UserInput[]，按 [local_image, ..., text] 顺序
 *   （与 Claude SDK image-block-first 顺序对齐，让 LLM 先看到图再读问题）
 *
 * codex SDK `local_image` 只接 path，不接 base64：path 已由 IPC 层 writeUploadedImage
 * 落盘到 <userData>/image-uploads/<uuid>.<ext>，codex 子进程自己 fs 读。
 */
function packCodexInput(text: string, attachments?: UploadedAttachmentRef[]): Input {
  if (!attachments || attachments.length === 0) return text;
  const items: UserInput[] = [];
  for (const ref of attachments) {
    items.push({ type: 'local_image', path: ref.path });
  }
  if (text.length > 0) {
    items.push({ type: 'text', text });
  }
  return items;
}

/**
 * 从 codex Input 中提取 attachments path 集合（用于 closeSession 时清理 unused 文件）。
 *
 * 仅扫 UserInput[] 形态；string 形态直接返回 []。
 */
function extractAttachmentPaths(input: Input): string[] {
  if (typeof input === 'string') return [];
  const paths: string[] = [];
  for (const item of input) {
    if (item.type === 'local_image' && typeof item.path === 'string') {
      paths.push(item.path);
    }
  }
  return paths;
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
  private codex: Codex | null = null;
  /** 用户在设置面板填的 codex 二进制路径覆盖；null = 用 SDK vendored 二进制 */
  private codexCliPath: string | null = null;
  /**
   * 当前 codex 沙盒档位（CHANGELOG_54 B-4）。默认与历史硬编码一致 'workspace-write'，
   * 下次 createSession 调 startThread 时透传。已在跑的 thread 不受影响（sandboxMode 是
   * startThread 一次性参数，与 claudeCodeSandbox 同模式 spawn-time 锁定）。
   */
  private currentSandboxMode: 'workspace-write' | 'read-only' | 'danger-full-access' =
    'workspace-write';
  /**
   * CHANGELOG_52 Step 4b：ThreadLoop sub-class 持 startNewThreadAndAwaitId + runTurnLoop。
   * sessions Map / emit 通过 ThreadLoopCtx 注入；class 上 createSession / sendMessage 内的
   * 调用走 this.threadLoop.xxx 委托。
   */
  private threadLoop: ThreadLoop;

  constructor(private opts: CodexBridgeOptions) {
    const ctx: ThreadLoopCtx = {
      sessions: this.sessions,
      emit: opts.emit,
    };
    this.threadLoop = new ThreadLoop(ctx);
  }

  /** 设置面板「Codex 二进制路径」变更：清掉 Codex 实例，下次 createSession 重建。 */
  setCodexCliPath(path: string | null): void {
    this.codexCliPath = path && path.trim() ? path.trim() : null;
    // 清掉 Codex 实例。已存在的 Thread 实例继续用旧 codex 配置（codex 实例只在 spawn 子进程时被读到，
    // 旧 thread 下次 runStreamed 时会用旧 path；新建会话才用新 path）。可以接受：用户改 path
    // 通常不需要立即影响在跑的会话。
    this.codex = null;
  }

  /**
   * 设置面板「Codex 沙盒档位」变更：仅更新本字段，不清 codex 实例（sandboxMode 不在
   * codex 实例上，是 startThread 调用时透传）。已在跑的 thread 已按旧档位 spawn 不受影响；
   * 新建会话使用新值。
   */
  setCodexSandboxMode(mode: 'workspace-write' | 'read-only' | 'danger-full-access'): void {
    this.currentSandboxMode = mode;
  }

  private async ensureCodex(): Promise<Codex> {
    if (this.codex) return this.codex;
    const sdk = await loadCodexSdk();
    // 优先级：用户在设置面板填的 codexCliPath（可指向自装版本）> 打包后内置的 unpacked 二进制
    // > SDK 自己 resolve（dev 模式正常，打包后会拼出 app.asar 内路径导致 spawn ENOTDIR，见
    // resolveBundledCodexBinary 注释）
    const overridePath = this.codexCliPath || resolveBundledCodexBinary();
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
    const cwd = opts.cwd && opts.cwd.trim() ? opts.cwd : process.cwd();
    // CHANGELOG_<X> A2a：codexSandbox 优先级（高 → 低）：
    // 1. opts.codexSandbox（NewSessionDialog / IPC / cli.ts 显式传入，最新意图）
    // 2. resume 路径下 sessionRepo.get(resume).codexSandbox（用户上次该会话选过的，重启应用后回放）
    // 3. bridge.currentSandboxMode（settings.codexSandbox 全局值兜底）
    // 不写 4. settings 直接读 — bridge.currentSandboxMode 已经是 settings 的最新镜像（setCodexSandboxMode 触发更新）
    const persistedSandbox = opts.resume
      ? (sessionRepo.get(opts.resume)?.codexSandbox ?? null)
      : null;
    const sandboxMode = opts.codexSandbox ?? persistedSandbox ?? this.currentSandboxMode;

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
      // try/catch 兜底：DB 异常不应阻塞会话启动（最坏情况只是字段没存，下次会话退化默认）。
      try {
        sessionRepo.setCodexSandbox(opts.resume, sandboxMode);
      } catch (err) {
        console.warn(`[codex-bridge] setCodexSandbox(${opts.resume}, ${sandboxMode}) 失败`, err);
      }
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
      // 启动 turn loop（不阻塞当前 createSession）
      void this.threadLoop.runTurnLoop(internal, opts.resume);
      return { sessionId: opts.resume };
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

    // CHANGELOG_<X> A2a：新建路径拿到 realId 后持久化 sandboxMode。
    // startNewThreadAndAwaitId 内部已 emit session-start（同步派发 → ingest 创建 record），
    // 此处 setCodexSandbox 紧跟 await 之后跑，UPDATE 必然命中。
    try {
      sessionRepo.setCodexSandbox(realId, sandboxMode);
    } catch (err) {
      console.warn(`[codex-bridge] setCodexSandbox(${realId}, ${sandboxMode}) 失败`, err);
    }

    return { sessionId: realId };
  }

  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
  ): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`session ${sessionId} not found`);

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
   * 与 claude restartWithPermissionMode 同模式：
   * - emit 占位 message → close OLD → 写 DB → createSession({resume, codexSandbox, prompt})
   * - 失败回滚 sessionRepo.codexSandbox + emit error message
   *
   * codex SDK sandboxMode 是 startThread/resumeThread spawn-time 锁定，无法运行时热切；
   * 必须冷切（销毁旧 thread + 重建）。spike-A2 实测确认 resumeThread 透传新 sandbox 真生效。
   *
   * @returns 重启后的 sessionId（codex resume 不会隐式 fork，理论上等于入参 sid，
   *   但接口签名与 claude 对齐保留 string 返回）
   */
  async restartWithCodexSandbox(
    sessionId: string,
    sandbox: 'workspace-write' | 'read-only' | 'danger-full-access',
    handoffPrompt: string,
  ): Promise<string> {
    if (!handoffPrompt.trim()) {
      throw new Error(
        'restartWithCodexSandbox 要求 handoffPrompt 非空（codex SDK runStreamed 协议约束，' +
          'resume 路径必须有 prompt 触发首条 turn）',
      );
    }

    const rec = sessionRepo.get(sessionId);
    if (!rec) throw new Error(`session ${sessionId} not found in repo`);
    const oldSandbox: 'workspace-write' | 'read-only' | 'danger-full-access' | null =
      rec.codexSandbox ?? null;

    // 占位 message：让用户在 close + 重建 期间看到状态（与 claude 冷切同模式）
    this.opts.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: {
        text: `⚠ 正在切换 Codex sandbox 到 ${sandbox}，重启 thread 中…`,
      },
      ts: Date.now(),
      source: 'sdk',
    });

    // close OLD：内部 intentionallyClosed=true → abort current turn → runTurnLoop 静默退出
    await this.closeSession(sessionId);

    // 先写 DB：让 createSession resume 路径能从 sessionRepo 读到新 sandbox
    sessionRepo.setCodexSandbox(sessionId, sandbox);

    try {
      const handle = await this.createSession({
        cwd: rec.cwd,
        prompt: handoffPrompt,
        resume: sessionId,
        codexSandbox: sandbox,
      });
      // codex resume 不会隐式 fork（与 claude SDK 不同），newRealId 必然 = 入参 sessionId。
      // 不做 rename 防御（如果未来 codex 改了行为引入 fork，本处需要补 sessionManager.renameSdkSession）。
      return handle.sessionId;
    } catch (err) {
      // 回滚：DB 改回 oldSandbox + emit error message
      sessionRepo.setCodexSandbox(sessionId, oldSandbox);
      this.opts.emit({
        sessionId,
        agentId: AGENT_ID,
        kind: 'message',
        payload: {
          text:
            `⚠ 切到 sandbox ${sandbox} 失败：${(err as Error)?.message ?? String(err)}。` +
            `档位已回退到 ${oldSandbox ?? '(默认)'}，请重新发送一条消息让 Codex 续上。`,
          error: true,
        },
        ts: Date.now(),
        source: 'sdk',
      });
      throw err;
    }
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
}
