import { randomUUID } from 'node:crypto';
import type { Codex, Thread, ThreadEvent } from '@openai/codex-sdk';
import type { AgentEvent, AgentEventKind } from '@shared/types';
import { sessionManager } from '@main/session/manager';
import { loadCodexSdk } from '@main/adapters/codex-cli/sdk-loader';
import { translateCodexEvent } from '@main/adapters/codex-cli/translate';

const AGENT_ID = 'codex-cli';

/** 单条用户消息字节上限（与 claude-code 对齐：100KB）。 */
const MAX_MESSAGE_BYTES = 100_000;
/** 单会话 pendingMessages 队列上限（与 claude-code 对齐：20 条）。 */
const MAX_PENDING_MESSAGES = 20;

/** 30 秒未拿到 thread.started 事件就 fallback：避免 createSession 永远 hang。 */
const THREAD_STARTED_FALLBACK_MS = 30_000;

export interface CodexSessionHandle {
  sessionId: string;
}

export interface CodexBridgeOptions {
  emit: (e: AgentEvent) => void;
}

interface InternalSession {
  /** 真实 thread_id，第一次 thread.started 事件后写入。resume 路径在创建时就有。 */
  threadId: string | null;
  cwd: string;
  thread: Thread;
  /** 待发送 user message 串行队列（同 thread 不能并发 turn） */
  pendingMessages: string[];
  /** 当前正在跑的 turn 的 AbortController；中断时调用 abort() */
  currentTurn: AbortController | null;
  /** turn loop 是否在跑（避免 sendMessage 重复启动） */
  turnLoopRunning: boolean;
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

  constructor(private opts: CodexBridgeOptions) {}

  /** 设置面板「Codex 二进制路径」变更：清掉 Codex 实例，下次 createSession 重建。 */
  setCodexCliPath(path: string | null): void {
    this.codexCliPath = path && path.trim() ? path.trim() : null;
    // 清掉 Codex 实例。已存在的 Thread 实例继续用旧 codex 配置（codex 实例只在 spawn 子进程时被读到，
    // 旧 thread 下次 runStreamed 时会用旧 path；新建会话才用新 path）。可以接受：用户改 path
    // 通常不需要立即影响在跑的会话。
    this.codex = null;
  }

  private async ensureCodex(): Promise<Codex> {
    if (this.codex) return this.codex;
    const sdk = await loadCodexSdk();
    this.codex = new sdk.Codex(
      this.codexCliPath ? { codexPathOverride: this.codexCliPath } : {},
    );
    return this.codex;
  }

  async createSession(opts: {
    cwd: string;
    prompt?: string;
    model?: string;
    /** 传 thread_id 表示恢复历史会话；codex 从 ~/.codex/sessions/<id>.jsonl 重放 */
    resume?: string;
  }): Promise<CodexSessionHandle> {
    if (!opts.prompt || !opts.prompt.trim()) {
      throw new Error('首条消息不能为空：codex SDK 需要至少一条 prompt 才能启动 turn');
    }

    const codex = await this.ensureCodex();
    const cwd = opts.cwd && opts.cwd.trim() ? opts.cwd : process.cwd();

    let thread: Thread;
    if (opts.resume) {
      thread = codex.resumeThread(opts.resume, { skipGitRepoCheck: true });
    } else {
      thread = codex.startThread({
        workingDirectory: cwd,
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        skipGitRepoCheck: true,
        ...(opts.model ? { model: opts.model } : {}),
      });
    }

    const internal: InternalSession = {
      threadId: opts.resume ?? null,
      cwd,
      thread,
      pendingMessages: [opts.prompt],
      currentTurn: null,
      turnLoopRunning: false,
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
      this.opts.emit({
        sessionId: opts.resume,
        agentId: AGENT_ID,
        kind: 'message',
        payload: { text: opts.prompt, role: 'user' },
        ts: Date.now(),
        source: 'sdk',
      });
      // 启动 turn loop（不阻塞当前 createSession）
      void this.runTurnLoop(internal, opts.resume);
      return { sessionId: opts.resume };
    }

    // 新建路径：先用 tempKey 占位，等 thread.started 事件拿到 realId 后 rename
    const tempKey = randomUUID();
    this.sessions.set(tempKey, internal);
    const realId = await this.startNewThreadAndAwaitId(internal, tempKey, opts.prompt, cwd);

    return { sessionId: realId };
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`session ${sessionId} not found`);

    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_MESSAGE_BYTES) {
      throw new Error(
        `单条消息 ${(bytes / 1000).toFixed(1)}KB 超过 ${MAX_MESSAGE_BYTES / 1000}KB 上限。请精简或拆分发送。`,
      );
    }

    if (s.pendingMessages.length >= MAX_PENDING_MESSAGES) {
      throw new Error(
        `待发送队列已堆积 ${MAX_PENDING_MESSAGES} 条。请等当前 turn 跑完再继续发送。`,
      );
    }

    s.pendingMessages.push(text);
    this.opts.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: { text, role: 'user' },
      ts: Date.now(),
      source: 'sdk',
    });

    // 触发 turn loop（如果当前没在跑就启）
    if (!s.turnLoopRunning) {
      void this.runTurnLoop(s, sessionId);
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
   * 启动新 thread 的第一个 turn，等 thread.started 事件拿到 thread_id，期间 30s 兜底超时。
   * 拿到 realId 后切 sessions map key + 调 sessionManager 注册。
   */
  private async startNewThreadAndAwaitId(
    internal: InternalSession,
    tempKey: string,
    prompt: string,
    cwd: string,
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      let resolved = false;
      const fallback = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        // 30s 兜底：用 tempKey 作为 realId 顶上，让 UI 至少能看到这条会话
        internal.threadId = tempKey;
        sessionManager.claimAsSdk(tempKey);
        this.opts.emit({
          sessionId: tempKey,
          agentId: AGENT_ID,
          kind: 'session-start',
          payload: { cwd, source: 'sdk' },
          ts: Date.now(),
          source: 'sdk',
        });
        this.opts.emit({
          sessionId: tempKey,
          agentId: AGENT_ID,
          kind: 'message',
          payload: { text: prompt, role: 'user' },
          ts: Date.now(),
          source: 'sdk',
        });
        this.opts.emit({
          sessionId: tempKey,
          agentId: AGENT_ID,
          kind: 'message',
          payload: {
            text:
              '⚠ Codex SDK 30 秒内未发出 thread_id。可能原因：codex 二进制启动失败 / 鉴权未配置 / 代理超限。' +
              '请在终端运行 `codex auth` 验证鉴权，或检查设置面板的「Codex 二进制路径」。',
            error: true,
          },
          ts: Date.now(),
          source: 'sdk',
        });
        resolve(tempKey);
      }, THREAD_STARTED_FALLBACK_MS);

      void this.runTurnLoop(internal, tempKey, (realId) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(fallback);
        if (realId !== tempKey) {
          // 切 sessions map 的 key
          this.sessions.delete(tempKey);
          this.sessions.set(realId, internal);
          sessionManager.claimAsSdk(realId);
          // 把已经登记到 sessionManager 的 tempKey 行迁移到 realId
          // （实际上 tempKey 还没进 sessionManager —— 我们等到 thread.started 才 claim）
          // 但保险起见调一次 rename，sessionManager 内部会处理「from 不存在」的 noop
          sessionManager.renameSdkSession(tempKey, realId);
        } else {
          sessionManager.claimAsSdk(realId);
        }
        this.opts.emit({
          sessionId: realId,
          agentId: AGENT_ID,
          kind: 'session-start',
          payload: { cwd, source: 'sdk' },
          ts: Date.now(),
          source: 'sdk',
        });
        this.opts.emit({
          sessionId: realId,
          agentId: AGENT_ID,
          kind: 'message',
          payload: { text: prompt, role: 'user' },
          ts: Date.now(),
          source: 'sdk',
        });
        resolve(realId);
      });
    });
  }

  /**
   * 串行消费 pendingMessages 的 turn loop。同时刻只跑一个 turn（codex thread 限制）。
   *
   * @param key 最初登记到 sessions map 的 key（tempKey 或 resume 的 realId）
   * @param onFirstId 拿到第一条 thread.started 时回调（仅新建路径需要）
   */
  private async runTurnLoop(
    internal: InternalSession,
    key: string,
    onFirstId?: (id: string) => void,
  ): Promise<void> {
    if (internal.turnLoopRunning) return;
    internal.turnLoopRunning = true;
    let firstIdCb = onFirstId;
    try {
      while (internal.pendingMessages.length > 0) {
        const text = internal.pendingMessages.shift()!;
        const controller = new AbortController();
        internal.currentTurn = controller;
        // emit 闭包：sid 取最新的 realId（thread_id 在第一条 thread.started 后才有）
        const emit = (kind: AgentEventKind, payload: unknown): void => {
          this.opts.emit({
            sessionId: internal.threadId ?? key,
            agentId: AGENT_ID,
            kind,
            payload,
            ts: Date.now(),
            source: 'sdk',
          });
        };
        try {
          const { events } = await internal.thread.runStreamed(text, {
            signal: controller.signal,
          });
          for await (const ev of events) {
            // 拦截 thread.started：拿到真实 thread_id，通知 createSession promise resolve
            if (ev.type === 'thread.started' && !internal.threadId) {
              internal.threadId = ev.thread_id;
              if (firstIdCb) {
                firstIdCb(ev.thread_id);
                firstIdCb = undefined;
              }
            }
            translateCodexEvent(ev as ThreadEvent, emit);
          }
        } catch (err) {
          const aborted = controller.signal.aborted;
          const msg = err instanceof Error ? err.message : String(err);
          if (aborted) {
            emit('finished', { ok: false, subtype: 'interrupted' });
          } else {
            emit('message', { text: `⚠ Codex turn 异常：${msg}`, error: true });
            emit('finished', { ok: false, subtype: 'error' });
          }
        } finally {
          internal.currentTurn = null;
        }
      }
    } finally {
      internal.turnLoopRunning = false;
    }
  }
}
