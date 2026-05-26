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
import type { AgentEventKind, HandOffMetadata, UploadedAttachmentRef } from '@shared/types';
import { sessionManager } from '@main/session/manager';
import { translateCodexEvent } from '@main/adapters/codex-cli/translate';
import { AGENT_ID, THREAD_STARTED_FALLBACK_MS } from './constants';
import type { CodexBridgeOptions, InternalSession } from './types';

export interface ThreadLoopCtx {
  /** 共享 sessions Map ref（facade 持有） */
  readonly sessions: Map<string, InternalSession>;
  readonly emit: CodexBridgeOptions['emit'];
  /**
   * P5 Round 1 reviewer-claude MED-1 修法 (resolveWithFallback 漏清):
   * resolveWithFallback (30s timeout / earlyErr) 走兜底路径时必须清 codexBySession + token map
   * (sessions Map 仍保留是 intentional — 让 sendMessage 走 silent break 而非 recoverer,避免对死
   * 会话反复 spawn 子进程)。closeSession 标准 cleanup 含双轨,resolveWithFallback 缺 → leak 直到
   * 用户主动 close。facade 注入 thunk 实现解耦,thread-loop 不直接 import codexBySession /
   * mcp-session-token-map 模块。失败 swallow 不阻塞 fallback emit 序列。
   */
  readonly cleanupTempKey: (tempKey: string) => void;
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
    /**
     * plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.2 第 9 步 (codex 端 thread-loop
     * 函数签名加 handOff 入参):bridge createSession 调本 method 时透传 opts.handOff,让 thread-loop
     * fallback (:95-99) + success (:170-173) 2 处 first-user-message emit 时 spread 进 events.payload
     * (详 plan §不变量 5 — codex 3 处 emit:fallback / success / sdk-bridge resume)。
     */
    handOff?: HandOffMetadata,
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
        // P5 Round 1 reviewer-claude MED-1 修法:fallback 路径(30s timeout / earlyErr)清 codexBySession
        // + mcp-session-token-map entry。sessions Map 仍保留 intentional — sendMessage 走 silent break
        // 防对死会话反复 spawn(详 ThreadLoopCtx.cleanupTempKey 注释)。失败 swallow 不阻塞 fallback emit。
        try {
          this.ctx.cleanupTempKey(tempKey);
        } catch (cleanupErr) {
          console.warn(
            `[codex-thread-loop] cleanupTempKey(${tempKey}) failed during resolveWithFallback:`,
            cleanupErr,
          );
        }
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
            // plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.2 第 10 步 (codex
            // fallback first-user-message emit 3 处之一):spread handOff metadata。**不变量 5
            // 严守**:本 emit 是 user-prompt(`role: 'user'`),与下方 :103-110 error emit
            // (`payload: {text: errorText, error: true}` 无 `role: 'user'`)不同语义,error
            // emit 绝对不能 spread handOff(污染 error 语义 + 未来扫 events 误把 error 计入
            // hand-off baton 链)。
            ...(handOff ? { handOff } : {}),
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
              // plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.2 第 10 步 (codex
              // success first-user-message emit 3 处之一):spread handOff metadata,与 fallback
              // 同款不变量 5 守门(本 emit `role: 'user'` 携带,error emit 不携带)。
              ...(handOff ? { handOff } : {}),
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
    _key: string,
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
        // **plan reverse-rename-sid-stability-20260520 §A.4-pre S4 R4 HIGH-H 修订**:
        // emit event sid 用 internal.applicationSid (D7 不变量 3 wire prefix [sid] 100% 写 sessions.id);
        // applicationSid 在 spawn 主路径 first thread.started 到达时切到 realId 后冻结 (S2 + S3
        // case 1 isNewSpawn 分支保护),resume/fallback 路径 ctor 时 = opts.resume 全程不变。
        const emit = (kind: AgentEventKind, payload: unknown): void => {
          this.ctx.emit({
            sessionId: internal.applicationSid,
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
            // 拦截 thread.started：拿到真实 thread_id。三种情况处理（symmetry-plan P2 MED-D）：
            // 1. 新建路径（!internal.threadId）：第一次拿到 thread_id，设字段 + 触发 firstIdCb
            // 2. 恢复路径正常 case（internal.threadId === ev.thread_id）：仅触发 firstIdCb
            //    通知外层 awaitResumeFirstThreadId 等到了 SDK 实际启动 → resolve
            // 3. 恢复路径 SDK 返回不同 id（internal.threadId !== ev.thread_id）：CLI 隐式 fork —
            //    当前 codex CLI 实测不会发生（spike-A2 验证 + restart-controller.ts:97 注释），
            //    但 SDK 源码不阻止此行为（dist/index.js:84-87 无条件 swap _id），future-proof
            //    防 SDK 升级 / CLI 行为变更。修前 `&& !internal.threadId` 保护让 resume 路径
            //    跳过 ev.thread_id 校验 → app 层 ↔ SDK actual id silent split → 历史会话静默断链。
            if (ev.type === 'thread.started') {
              if (!internal.threadId) {
                // case 1: 新建路径 — spawn 主路径 first thread.started 到达
                // **plan reverse-rename-sid-stability-20260520 §A.4-pre S3 R3 HIGH-F + R7 HIGH-R7-1
                // isNewSpawn 三分支保护 (codex 对称)**:
                // - spawn 主路径 (无 opts.resume + resumeMode='resume-cli' default):
                //   internal.applicationSid = ev.thread_id (切到 first thread_id 后冻结) +
                //   internal.threadId = ev.thread_id + sessionManager.renameSdkSession (D2)
                // - resume / fallback 路径 (有 opts.resume): applicationSid 全程不变 (S2 jsdoc),
                //   仅 update internal.threadId (本 case 1 走 !internal.threadId 分支不进 resume case 3)
                // 当前 case 1 仅 spawn 主路径触发 (resume 路径 ctor 时 internal.threadId 已有 opts.resume),
                // 故无条件设 applicationSid 即可 (与 claude stream-processor.ts:271 isNewSpawn 分支同款)
                //
                // **CHANGELOG_139 双 reviewer 独立同款铁证 HIGH-1 修法**(reviewer-claude Opus 4.7
                // + reviewer-codex gpt-5.5 单轮异构对抗):plan reverse-rename-sid-stability-20260520
                // §A.4-pre S3 在 codex 端实施时漏了 `internal.applicationSid = ev.thread_id;` 这行
                // assignment(claude 端 stream-processor.ts:328 已落,codex 注释口头说"切到 first thread_id"
                // 但代码没切)。漏切导致 internal.applicationSid 永远是 ctor 时的 tempKey,
                // bridge.createSession 返 tempKey 不是 realId,spawn handler setSpawnLink(tempKey, ...)
                // 撞 sessions 表里没 tempKey row(rename.ts:57 fromRow 不存在直接 noop) → UPDATE
                // changes=0 静默失败,spawned_by 永远 NULL;后续 runTurnLoop 用 internal.applicationSid=
                // tempKey emit message → ingest 兜底 ensureRecord 建 tempKey row,cwd=''/title=sid 自身,
                // 与 firstIdCb emit session-start 写的 realId row 形成 split-brain 双 row。
                // 现场 SQL 实测 6 项指标 100% 命中预测(详 ref/reviews/REVIEW_50.md HIGH-1)。
                internal.applicationSid = ev.thread_id;
                internal.threadId = ev.thread_id;
                if (firstIdCb) {
                  firstIdCb(ev.thread_id);
                  firstIdCb = undefined;
                  earlyErrCb = undefined;
                }
              } else if (internal.threadId !== ev.thread_id) {
                // case 3: SDK 真 thread_id 与 internal.threadId 不一致
                // **两个触发路径**(REVIEW_56 R2 LOW-Cosmetic reviewer-claude 修订):
                //  - resumeThread fork: facade 走 resumeThread,SDK 真 fork 返新 thread_id(罕见
                //    + future-proof,codex spike-A2 实测当前 codex CLI 不会发生)
                //  - fresh-cli-reuse-app: facade 走 startThread(opts.resumeMode='fresh-cli-reuse-app'),
                //    SDK 起 fresh thread 返新 thread_id;internal.threadId = opts.resume = applicationSid
                //    (line 502),与 startThread 的 fresh thread_id 不一致 → 命中本 case 3
                // **plan reverse-rename-sid-stability-20260520 §A.4-pre S6 R5 HIGH-R5-1 + R6 MED-R6-1 修订**:
                // 走 sessionManager.updateCliSessionId (反向 rename 不动 sessions.id);
                // sessions Map key 不再切换 (S3 修订让 sessions Map key = applicationSid 不变);
                // 只 update internal.threadId 为新 SDK 返回的 thread_id (cli sid 维度)。
                const oldId = internal.threadId;
                const newId = ev.thread_id;
                console.warn(
                  `[codex-bridge] SDK returned thread_id ${newId} != tracked ${oldId} ` +
                    `(resumeThread-fork or fresh-cli-reuse-app startThread); ` +
                    `updating cli_session_id column on application sid ${internal.applicationSid} (走 manager 黑名单链)`,
                );
                internal.threadId = newId;
                // **R5 HIGH-R5-1 + R6 MED-R6-1 + R7 MED-R7-1 修订**: 第一参数 internal.applicationSid
                // (app sid 维度,不变量 1) 而非 oldId (cli sid 维度);走 manager 黑名单链确保
                // OLD_CLI_ID 进 recentlyDeleted 60s 防迟到 hook event 复活幽灵 record (不变量 5)。
                try {
                  sessionManager.updateCliSessionId(internal.applicationSid, newId);
                } catch (renameErr) {
                  console.error(
                    `[codex-bridge] post-resume updateCliSessionId failed app=${internal.applicationSid} → ${newId}, ` +
                      `NEW thread runs but cli_session_id 列未更新 + OLD_CLI_ID 未入黑名单.`,
                    renameErr,
                  );
                }
                if (firstIdCb) {
                  firstIdCb(newId);
                  firstIdCb = undefined;
                  earlyErrCb = undefined;
                }
              } else if (firstIdCb) {
                // case 2: 恢复路径正常 case — id 一致仅触发 cb
                firstIdCb(ev.thread_id);
                firstIdCb = undefined;
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
