/**
 * ThreadLoop — Codex thread 启动 + turn loop（CHANGELOG_52 Step 4b）。
 *
 * 抽自 codex-cli/sdk-bridge.ts 的 startNewThreadAndAwaitId + runTurnLoop 两个 private 方法。
 *
 * 通过 ThreadLoopCtx 注入 sessions Map ref + emit。
 *
 * 护栏（不变）：
 * - REVIEW_4 H1+M5 — runTurnLoop catch 内 `if (internal.intentionallyClosed) break` 静默退出
 * - REVIEW_4 M5 — 30s fallback 必须先 intentionallyClosed=true 再 abort，再 emit 完整序列
 *   （session-start → user msg → error → finished）
 * - earlyErrCb 路径与 closeSession / fallback 路径互斥，不出双 finished
 */
import type { ThreadEvent } from '@openai/codex-sdk';
import type { AgentEventKind, UploadedAttachmentRef } from '@shared/types';
import { sessionManager } from '@main/session/manager';
import { translateCodexEvent } from '@main/adapters/codex-cli/translate';
import { AGENT_ID, THREAD_STARTED_FALLBACK_MS } from './constants';
import type { CodexBridgeOptions, InternalSession } from './types';

export interface ThreadLoopCtx {
  /** 共享 sessions Map ref（facade 持有） */
  readonly sessions: Map<string, InternalSession>;
  readonly emit: CodexBridgeOptions['emit'];
}

export class ThreadLoop {
  constructor(private readonly ctx: ThreadLoopCtx) {}

  /**
   * 新建 thread + 等首条 thread.started 事件 + 30s fallback。
   *
   * 三条收尾路径（resolve 走同一段 emit 序列保证 UI 看到完整一条会话）：
   * 1. 正常拿到 thread_id → realId（可能 ≠ tempKey）→ rename + emit session-start + user msg
   * 2. 30s fallback → tempKey 顶上，emit error + finished
   * 3. earlyErr（spawn 立即失败）→ 同 fallback，但 errorText 用 SDK 抛的真实 stderr
   *
   * 首条消息已由 caller push 进 `internal.pendingMessages`（避免重复传参）；
   * `promptText` + `attachments` 是给 emit message event 的 payload，
   * 让 UI 显示纯文本 + 附图缩略图（emit payload 不直接含 codex Input 形态）。
   */
  async startNewThreadAndAwaitId(
    internal: InternalSession,
    tempKey: string,
    cwd: string,
    promptText: string,
    attachments?: UploadedAttachmentRef[],
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      let resolved = false;

      /**
       * 用 tempKey 顶上 realId 的兜底路径。errorText 是要显示给用户的错误消息：
       * - 30s 超时 → 固定文案（提示查鉴权 / 二进制路径）
       * - early error → SDK 抛出的真实 stderr，准确指向根因
       */
      const resolveWithFallback = (errorText: string): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(fallback);
        internal.threadId = tempKey;
        sessionManager.claimAsSdk(tempKey);
        this.ctx.emit({
          sessionId: tempKey,
          agentId: AGENT_ID,
          kind: 'session-start',
          payload: { cwd, source: 'sdk' },
          ts: Date.now(),
          source: 'sdk',
        });
        this.ctx.emit({
          sessionId: tempKey,
          agentId: AGENT_ID,
          kind: 'message',
          payload: {
            text: promptText,
            role: 'user',
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
          },
          ts: Date.now(),
          source: 'sdk',
        });
        this.ctx.emit({
          sessionId: tempKey,
          agentId: AGENT_ID,
          kind: 'message',
          payload: { text: errorText, error: true },
          ts: Date.now(),
          source: 'sdk',
        });
        this.ctx.emit({
          sessionId: tempKey,
          agentId: AGENT_ID,
          kind: 'finished',
          payload: { ok: false, subtype: 'error' },
          ts: Date.now(),
          source: 'sdk',
        });
        resolve(tempKey);
      };

      const fallback = setTimeout(() => {
        // 30s 内 codex 既没吐 thread.started 也没退出 → 中断它，避免子进程继续挂着。
        // REVIEW_4 M5：必须先设 intentionallyClosed=true 让 runTurnLoop catch 静默退出，
        // 否则 catch 走 aborted 分支再 emit finished:interrupted，与本路径下面
        // resolveWithFallback 的 finished:error 凑成双 finished + 双系统通知。
        internal.intentionallyClosed = true;
        try {
          internal.currentTurn?.abort();
        } catch {
          // ignore
        }
        resolveWithFallback(
          '⚠ Codex SDK 30 秒内未发出 thread_id。可能原因：codex 二进制启动失败 / 鉴权未配置 / 代理超限。' +
            '请在终端运行 `codex auth` 验证鉴权，或检查设置面板的「Codex 二进制路径」。',
        );
      }, THREAD_STARTED_FALLBACK_MS);

      void this.runTurnLoop(
        internal,
        tempKey,
        (realId) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(fallback);
          if (realId !== tempKey) {
            // 切 sessions map 的 key
            this.ctx.sessions.delete(tempKey);
            this.ctx.sessions.set(realId, internal);
            sessionManager.claimAsSdk(realId);
            // 把已经登记到 sessionManager 的 tempKey 行迁移到 realId
            // （实际上 tempKey 还没进 sessionManager —— 我们等到 thread.started 才 claim）
            // 但保险起见调一次 rename，sessionManager 内部会处理「from 不存在」的 noop
            sessionManager.renameSdkSession(tempKey, realId);
          } else {
            sessionManager.claimAsSdk(realId);
          }
          this.ctx.emit({
            sessionId: realId,
            agentId: AGENT_ID,
            kind: 'session-start',
            payload: { cwd, source: 'sdk' },
            ts: Date.now(),
            source: 'sdk',
          });
          this.ctx.emit({
            sessionId: realId,
            agentId: AGENT_ID,
            kind: 'message',
            payload: {
              text: promptText,
              role: 'user',
              ...(attachments && attachments.length > 0 ? { attachments } : {}),
            },
            ts: Date.now(),
            source: 'sdk',
          });
          resolve(realId);
        },
        (earlyErr) => {
          // 第一个 turn 在拿到 thread_id 前就抛了（codex 子进程立即 exit / spawn 失败）。
          // SDK 抛的 message 形如 `Codex Exec exited with code N: <stderr>`，
          // 直接作为错误消息透给用户——比 30s 后那条固定文案准确得多。
          resolveWithFallback(`⚠ Codex 启动失败：${earlyErr}`);
        },
      );
    });
  }

  /**
   * 串行消费 pendingMessages 的 turn loop。同时刻只跑一个 turn（codex thread 限制）。
   *
   * @param key 最初登记到 sessions map 的 key（tempKey 或 resume 的 realId）
   * @param onFirstId 拿到第一条 thread.started 时回调（仅新建路径需要）
   * @param onEarlyError 第一个 turn 在拿到 thread.started 之前就抛错时回调（仅新建路径需要）。
   *   走这条路径时本函数不再 emit 错误消息——由外层 startNewThreadAndAwaitId 统一发，
   *   保证 UI 看到的是一条完整的 session-start → user msg → error → finished 序列。
   */
  async runTurnLoop(
    internal: InternalSession,
    key: string,
    onFirstId?: (id: string) => void,
    onEarlyError?: (msg: string) => void,
  ): Promise<void> {
    if (internal.turnLoopRunning) return;
    internal.turnLoopRunning = true;
    let firstIdCb = onFirstId;
    let earlyErrCb = onEarlyError;
    try {
      while (internal.pendingMessages.length > 0) {
        const input = internal.pendingMessages.shift()!;
        const controller = new AbortController();
        internal.currentTurn = controller;
        // emit 闭包：sid 取最新的 realId（thread_id 在第一条 thread.started 后才有）
        const emit = (kind: AgentEventKind, payload: unknown): void => {
          this.ctx.emit({
            sessionId: internal.threadId ?? key,
            agentId: AGENT_ID,
            kind,
            payload,
            ts: Date.now(),
            source: 'sdk',
          });
        };
        try {
          // codex SDK runStreamed 接 Input (= string | UserInput[])，类型自动适配
          const { events } = await internal.thread.runStreamed(input, {
            signal: controller.signal,
          });
          for await (const ev of events) {
            // 拦截 thread.started：拿到真实 thread_id，通知 createSession promise resolve
            if (ev.type === 'thread.started' && !internal.threadId) {
              internal.threadId = ev.thread_id;
              if (firstIdCb) {
                firstIdCb(ev.thread_id);
                firstIdCb = undefined;
                // 已拿到 thread_id：后续错误走常规 catch，不再算 early error
                earlyErrCb = undefined;
              }
            }
            translateCodexEvent(ev as ThreadEvent, emit);
          }
        } catch (err) {
          // REVIEW_4 H1+M5：被 closeSession / 30s timeout fallback 主动 abort 的，静默退出。
          // 否则发 finished:interrupted 让 manager 把已删 session 复活成幽灵，
          // 或与 fallback 自己 emit 的 finished:error 凑成双 finished。
          if (internal.intentionallyClosed) {
            internal.currentTurn = null;
            break;
          }
          const aborted = controller.signal.aborted;
          const msg = err instanceof Error ? err.message : String(err);
          if (aborted) {
            emit('finished', { ok: false, subtype: 'interrupted' });
          } else if (earlyErrCb) {
            // 第一个 turn 在拿到 thread.started 前就挂了（codex spawn 后立即 exit）。
            // 通知 startNewThreadAndAwaitId 用真实 stderr 立即结算外层 promise，
            // 然后 break 出 while——已死的 thread 不再处理后续 pendingMessages。
            earlyErrCb(msg);
            earlyErrCb = undefined;
            firstIdCb = undefined;
            internal.currentTurn = null;
            break;
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
