/**
 * StreamProcessor — SDK 流消费 + 真实 session_id 等待 + user message stream（CHANGELOG_52 Step 3e）。
 *
 * 抽自 sdk-bridge.ts 4 个 private 方法：
 * - makeUserMessage（纯函数，转 SDKUserMessage shape）
 * - createUserMessageStream（AsyncIterable yield pendingUserMessages，检测 close）
 * - waitForRealSessionId（等首条 SDKMessage 拿 realId，30s fallback）
 * - consume（消费 SDKMessage 流 → translate 翻译 → emit + 流终止时清 pending）
 *
 * 全部通过 StreamProcessorCtx 注入 sessions Map ref + emit。
 *
 * 护栏（不变）：
 * - REVIEW_5 H4 — waitForRealSessionId 30s fallback 用 resumeId 作 fallbackId（避免造孤儿 tempKey）
 * - CHANGELOG_27 — consume 内首条 realId !== resumeId → renameSdkSession(OLD, NEW)（CLI 隐式 fork 软兜底）
 * - CHANGELOG_34 — consume catch 内 internal.expectedClose=true 时 skip 红字（应用主动关闭副产品）
 * - CHANGELOG_47 — finally 流终止补 error message 给 UI 看到根因
 * - REVIEW_7 M3 — renameSdkSession 内聚 sdkOwned claim 转移
 * - 流终止时清 3 个 pending Maps（permission / ask-question / exit-plan）+ resolver 安全回退
 */
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { promises as fsp } from 'node:fs';
import { sessionManager } from '@main/session/manager';
import { AGENT_ID } from './constants';
import type { InternalSession, PendingUserMessage, SdkBridgeOptions } from './types';
import { translateSdkMessage } from './sdk-message-translate';
import type { UploadedAttachmentRef } from '@shared/types';

export interface StreamProcessorCtx {
  /** 共享 sessions Map ref（facade 持有，sub-class 仅读写不重新赋值） */
  readonly sessions: Map<string, InternalSession>;
  /** 共享 emit 函数（来自 SdkBridgeOptions.emit） */
  readonly emit: SdkBridgeOptions['emit'];
}

export class StreamProcessor {
  constructor(private readonly ctx: StreamProcessorCtx) {}

  /**
   * 把 (text, attachments?) 包成一个 thunk 入队。
   *
   * - 纯文本：thunk 同步 resolve，零 IO
   * - 带 attachments：thunk 内 await fs.readFile(path) + base64 + 构造 ContentBlockParam[]
   *
   * 注意：返回的是「构造 SDKUserMessage 的延迟操作」，不是 SDKUserMessage 本身。
   * consumer (createUserMessageStream) yield 前 await thunk()。
   */
  makeUserMessage(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
  ): PendingUserMessage {
    if (!attachments || attachments.length === 0) {
      // 纯文本快路径：thunk 同步 resolve，无 fs IO，无 base64
      const msg: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: sessionId,
      };
      return () => Promise.resolve(msg);
    }
    // 带图片：thunk 在 yield 前 await readFile + base64
    return async () => {
      // Anthropic SDK Base64ImageSource.media_type 严格限制 4 种字面量；
      // IPC 层 ALLOWED_UPLOAD_MIMES 已收口同款集合，这里 cast 安全。
      type ClaudeImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
      const blocks: Array<
        | { type: 'text'; text: string }
        | {
            type: 'image';
            source: { type: 'base64'; media_type: ClaudeImageMime; data: string };
          }
      > = [];
      for (const ref of attachments) {
        // 读盘失败让错误冒出去：consumer 端会让 SDK Query 抛错 → consume catch → emit 红字
        // path 已经在 IPC 层校验过 ext / size / 写盘成功，正常情况下读不到这里失败
        const buf = await fsp.readFile(ref.path);
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: ref.mime as ClaudeImageMime,
            data: buf.toString('base64'),
          },
        });
      }
      // 文字放最后：与 codex SDK 顺序对齐（local_image 在前 / text 在后），让 LLM 先看到图再读问题
      if (text.length > 0) {
        blocks.push({ type: 'text', text });
      }
      return {
        type: 'user',
        message: { role: 'user', content: blocks },
        parent_tool_use_id: null,
        session_id: sessionId,
      };
    };
  }

  async *createUserMessageStream(
    internal: InternalSession,
    tempKey: string,
  ): AsyncIterable<SDKUserMessage> {
    while (true) {
      while (internal.pendingUserMessages.length > 0) {
        const thunk = internal.pendingUserMessages.shift()!;
        // HIGH-2 修法：lazy materialize —— readFile + base64 在 yield 前才发生。
        // 队列只存 thunk（轻量），SDK consume 完后整条 SDKUserMessage GC，base64 不常驻
        yield await thunk();
      }
      await new Promise<void>((resolve) => {
        internal.notify = resolve;
      });
      internal.notify = null;
      const key = internal.realSessionId ?? tempKey;
      if (!this.ctx.sessions.has(key)) return;
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
  waitForRealSessionId(
    internal: InternalSession,
    tempKey: string,
    resumeId?: string,
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      let resolved = false;
      const fallback = setTimeout(() => {
        if (resolved) return;
        // **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 2.1 修法 (H1+M1 race 双保险 (A) abort consume)**:
        // fallback fire 路径在最早入口 fire-and-forget interrupt() — 减少 detached SDK 子进程
        // 在 fallback 之后继续跑 LLM 调用的 token cost (spike1 实证 interrupt() 让 SDK result
        // 走 error_during_execution 而非继续模型推理)。**不 await** interrupt() 避免阻塞 fallback
        // 同步路径 (spike1 实证 interrupt resolve 时机在 in-flight burst 之后,await 会让 fallback
        // 卡住几十-几百 ms)。**不能作为 race 唯一护栏** — race window 真正护栏在 consume L221
        // (B) guard (Phase 2.2)。
        //
        // **idempotency guard** (R2 plan-review *未验证* U-A): 防 caller 也手动 interrupt 与
        // fallback fire 并发触发 N round-trip — interruptFired flag 守门 (作用域仅本路径 +
        // createSession throw catch,不覆盖 public interrupt/closeSession 入口,详 types.ts
        // interruptFired 字段 jsdoc R3 收窄文案)。
        if (!internal.interruptFired) {
          internal.expectedClose = true;
          internal.interruptFired = true;
          void internal.query?.interrupt?.();
        }
        resolved = true;
        // REVIEW_5 H4：resume 路径下 fallback 直接落在 OLD_ID 上，避免造孤儿 tempKey
        const fallbackId = resumeId ?? tempKey;
        console.warn(`[sdk-bridge] no SDKMessage in 30s, falling back to id ${fallbackId}`);
        internal.realSessionId = fallbackId;
        // A1-HIGH-2 修法（plan deep-review-batch-a1-b-fixes-20260519 / REVIEW_46）:
        // 旧 impl 仅改 internal.realSessionId 不切 sessions Map key,与 consume L207-219
        // first-id 路径行为不对称。createSession 返回 fallbackId 后,sessions Map 仅有
        // tempKey: internal,不存在 fallbackId: internal → sendMessage(fallbackId) miss 触发
        // recoverer 起第二个 SDK CLI 子进程(双 CLI 同 jsonl);listPending(fallbackId)/respond
        // Permission/setPermissionMode/interrupt 都直接 sessions.get(fallbackId) miss → 假空
        // 或 silent miss 或 throw(A1-HIGH-2 reviewer-claude 反驳轮 5 关键缺失动作铁证)。修法:
        // 与 consume L207-219 first-id 路径同款 sessions Map key 切换;不调 renameSdkSession
        // (resume 场景 fallbackId === resumeId === OLD_ID,renameWithDb 走 toExists=true 但
        // tempKey 行不存在(还没 ingest)早返,实际 no-op,省 SQL)。
        if (tempKey !== fallbackId) {
          this.ctx.sessions.delete(tempKey);
          this.ctx.sessions.set(fallbackId, internal);
        }
        // 推一条错误消息，让 UI 在新会话里立刻看到出了什么问题，而不是空白等待。
        this.ctx.emit({
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
   *
   * **public** 是为了让 sdk-bridge.test.ts 通过 cast 直接调用（参考原 ClaudeSdkBridge.consume
   * 也是 private 但 test 用 `(bridge as unknown as {...}).consume` 同款 cast 访问）—— 拆分后
   * test 习惯保持，class 上 consume wrapper 转发到本方法。语义不变（仅 waitForRealSessionId
   * 内部 + facade test wrapper 调用）。
   */
  async consume(
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
          // **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 2.2 修法 (H1+H2 race 双保险 (B) consume guard)**:
          // R2 plan-review HIGH-A 修订：用临时 incomingId 局部变量 — guard 命中时**不能**直接
          // 写入 realId 然后 continue。如果 `realId = m.session_id` 后 continue 跳出当前 frame,
          // 但后续 frame `sid = realId ?? internal.realSessionId ?? tempKey` 三档链仍选 late id,
          // finally cleanup 同款撞 race。
          //
          // **race 真正护栏**：fallback fire 后 internal.realSessionId 已被 set 为 fallbackId
          // (Phase 2.1 + A1-HIGH-2 修法)。此时 SDK in-flight burst 仍 emit late first-id frame
          // (spike1 case A 实证)→ guard 命中 → console.warn + continue 让 translate 仍 emit 后续
          // frame (用 sid 三档链 → fallbackId) 但**不**改 sessions Map / **不**改 realId / **不**调
          // renameSdkSession,确保 fallbackId 上的 record 不丢失。
          //
          // 不变量 1: race 修法 land 后 fallback fire / createSession throw 路径 SDK 真发的 first
          // id frame 不能覆盖 fallback 已设的 fallbackId / 已 mutate 的 sessions Map。
          const incomingId = m.session_id;
          if (internal.realSessionId !== null && internal.realSessionId !== incomingId) {
            console.warn(
              `[sdk-bridge] late first-id arrived after fallback; ` +
                `incoming=${incomingId} fallback=${internal.realSessionId}; skipping mutation`,
            );
            // realId 保持 null,后续 frame `sid = realId ?? internal.realSessionId ?? tempKey`
            // 三档链 → fallbackId,translate 仍 emit 但不撞 sessions Map race。
            continue;
          }
          realId = incomingId;
          internal.realSessionId = realId;
          if (tempKey !== realId) {
            this.ctx.sessions.delete(tempKey);
            this.ctx.sessions.set(realId, internal);
            // fallback 路径：createSession 已用 tempKey 调过 claimAsSdk 并 emit 了 session-start，
            // sessionManager 已写入了一条以 tempKey 为 id 的「内」会话占位行（含 permission_mode 等）。
            // 用 rename 而不是 delete + new：保留 tempKey 行的内容（包括用户已选过的 permission_mode、
            // 已落库的事件 / 文件改动 / 总结），整体迁到 realId。renderer 侧通过 session-renamed
            // 事件同步迁移 selectedId / by-session 状态，不会被踢回主界面。
            // REVIEW_7 M3：renameSdkSession 内聚 sdkOwned claim 转移，调用方不再手工 release+claim。
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
          // 关键约束（REVIEW_7 L4 修正注释 → 与实际代码顺序一致）：
          // - 实际顺序：本 fork rename(OLD_ID → NEW_ID) 在 onFirstId(realId) 之前（即下面这行 1183 块），
          //   onFirstId 才 resolve waitForRealSessionId，createSession 才走到 line 467 emit session-start。
          //   也就是 rename 在 NEW_ID 的 session-start emit 之前发生 —— 此时 NEW_ID record 在 DB 中
          //   尚不存在。sessionRepo.rename (session-repo.ts:183-218) 对 toExists=false 走 INSERT
          //   复制 OLD_ID 内容（含 permission_mode 等）+ 迁子表 + DELETE OLD_ID 路径，结果与
          //   toExists=true 分支一致——OLD_ID 内容被完整保留到 NEW_ID 名下，干净无遗漏。
          // - claim 转移：renameSdkSession 内聚处理（REVIEW_7 M3），调用方不再手工 release/claim。
          if (resumeId && resumeId !== realId) {
            console.warn(
              `[sdk-bridge] CLI forked: requested resume=${resumeId} but got realId=${realId}; ` +
                `renaming OLD record → NEW so history continues under the new session id`,
            );
            // REVIEW_7 M3：renameSdkSession 内聚 sdkOwned claim 转移（resumeId → realId 原子），
            // 消除 fork 路径「fork rename → onFirstId → createSession 行 453 才 claimAsSdk(realId)」
            // 窗口内 NEW_ID 未 claim、hook 通道抢先 NEW_ID 事件造另一条 record 的微概率风险。
            sessionManager.renameSdkSession(resumeId, realId);
          }

          onFirstId(realId);
        }

        // **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 2.3 修法**：sid 三档链
        // `realId ?? internal.realSessionId ?? tempKey`。Phase 2.2 (B) guard 命中时 realId
        // 仍 null,但 internal.realSessionId 已被 fallback set 为 fallbackId → 选 fallbackId 让
        // late frame translate 走 fallbackId 而非 tempKey (避免 emit 给孤儿 sid)。
        const sid = realId ?? internal.realSessionId ?? tempKey;
        translateSdkMessage(this.ctx.emit, sid, m, internal);
      }
    } catch (err) {
      console.warn(`[sdk-bridge] query loop ended`, err);
      // 应用主动 close（含 approve-bypass 冷切 / SessionManager.delete / 应用退出清理）
      // 时 SDK 抛错（典型 [ede_diagnostic] 状态机不一致 / AbortError）属于设计内副产品，
      // 不弹「⚠ SDK 流中断」红字 message——避免 UI 时间线像系统出错。flag 在 closeSession
      // interrupt 之前 + approve-bypass resolver 之前都打过（双保险）。
      // 仍走 finally 清 pending Maps + emit session-end。
      if (internal.expectedClose) {
        // 早返：跳过 emit 红字，但仍走下面的 finally 兜底清理
      } else {
        // CHANGELOG_47：流中途抛错（鉴权过期 / token 限额 / CLI 子进程崩 / 网络）
        // 之前只 console.warn，UI 时间线只看到 session-end 不知道为什么。补一条 error message。
        // **Phase 2.3 同款三档链**：catch 里也用 `realId ?? internal.realSessionId ?? tempKey`
        // 让 fallback fire 后 catch 仍能 emit 给 fallbackId 而非 tempKey。
        const sid = realId ?? internal.realSessionId ?? tempKey;
        this.ctx.emit({
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
      }
    } finally {
      // **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 2.4 修法**：sid 三档链同款。
      // fallback 路径 realId 仍 null (Phase 2.2 guard 让 late id 不写 realId),但 internal.realSessionId
      // 已经是 fallbackId → cleanup 拿到正确 sid 删除 (sessions.delete + releaseSdkClaim)。
      // 不变量 1 兜底 — sessions Map 在 Phase 2.1 fallback fire 时已 set fallbackId entry,finally
      // 必须删之 (用 fallbackId 三档链 sid),否则 sessions Map 残留 fallbackId entry → 影响下次
      // sendMessage / closeSession / list。
      const sid = realId ?? internal.realSessionId ?? tempKey;
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
      // plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.5 修法 (A1-MED-1 codex):
      // 显式 clear pendingFileChangeIntents 防 leak (SDK 流终止前 tool_use 已 push 但 tool_result
      // 没回的 intent)。internal 整体被 sessions.delete 后会 GC 掉,显式 clear 与 toolUseNames /
      // pendingPermissions 等同款保险,不依赖 GC 时机。intent 是纯数据没 resolver,不需要 reject。
      internal.pendingFileChangeIntents.clear();
      this.ctx.emit({
        sessionId: sid,
        agentId: AGENT_ID,
        kind: 'session-end',
        payload: { reason: 'sdk-stream-ended' },
        ts: Date.now(),
        source: 'sdk',
      });
      this.ctx.sessions.delete(sid);
      this.ctx.sessions.delete(tempKey);
      sessionManager.releaseSdkClaim(sid);
    }
    return realId;
  }
}
