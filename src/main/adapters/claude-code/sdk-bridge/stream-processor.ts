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
 * - CHANGELOG_27/224 — consume 内区分真 CLI sid fork 与幻影运行 id，真 fork 只更新 cli_session_id
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
import { clearLiveTokenEstimate } from './live-token-rate';
import { translateSdkMessage } from './sdk-message-translate';
import { resetTurnUsageAccounting } from './thinking-token-usage';
import type { UploadedAttachmentRef } from '@shared/types';
import log from '@main/utils/logger';

const logger = log.scope('claude-stream');

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
        priority: 'now',
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
        priority: 'now',
        session_id: sessionId,
      };
    };
  }

  async *createUserMessageStream(
    internal: InternalSession,
    _tempKey: string,
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
      // **plan reverse-rename-sid-stability-20260520 §A.4-pre S4b R4 HIGH-H 修订**:
      // sessions Map key 是 applicationSid 维度 (S3 修订让 sessions.set 用 applicationSid),
      // createUserMessageStream 流式 prompt 喂 SDK 主循环必须用 applicationSid 才能命中
      // (否则反向 rename 后 cliSid != appSid 时 sessions.has(cliSid) miss → 用户 message 断流,
      // 用户报告 bug 触发场景之一)。
      const key = internal.applicationSid;
      if (this.ctx.sessions.get(key) !== internal) return;
    }
  }

  /**
   * 启动一个并行任务，从 query 流中读出第一条带 session_id 的消息，
   * 并按 applicationSid/cliSessionId 分工完成 sessions Map 与 DB cli_session_id 维护。同时把消息流的「消费」
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
    /**
     * **plan reverse-rename-sid-stability-20260520 §A.4-pre S1 + S6 R6 HIGH-R6-1 + R7 HIGH-R7-1**:
     * effectiveResumeCliSid (caller resolve 后的值) 透传给 consume() 让 S6 fork detect compare
     * 用此值不 short-circuit。caller (sdk-bridge/index.ts) 三分支 resolve:
     *   `opts.resumeMode === 'fresh-cli-reuse-app' ? undefined : !opts.resume ? undefined :`
     *   `(opts.resumeCliSid ?? sessionRepo.get(opts.resume)?.cliSessionId ?? opts.resume)`
     */
    effectiveResumeCliSid?: string,
    /**
     * **plan reverse-rename-sid-stability-20260520 §A.4-pre S1 R3 HIGH-G**:
     * resumeMode 透传给 consume() 让 isNewSpawn 三分支保护识别 fresh-cli-reuse-app 路径。
     */
    resumeMode?: 'resume-cli' | 'fresh-cli-reuse-app',
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
          // R3 fix-7 (I1 reviewer-claude INFO + codex A MED-1): 加 .catch 吞错防 unhandled
          // rejection（SDK interrupt 在 race 路径 reject 可能性 + spike1 实证 interrupt 多种边界
          // 行为含 reject 可能），console.warn 留痕。fire-and-forget 语义保持（不 await）。
          void internal.query?.interrupt?.().catch((err: unknown) => {
            logger.warn('[sdk-bridge] interrupt during setTimeout fallback failed:', err);
          });
        }
        resolved = true;
        // REVIEW_5 H4：resume 路径下 fallback 直接落在 OLD_ID 上，避免造孤儿 tempKey
        // **plan reverse-rename-sid-stability-20260520 §A.4-pre S2 + S3 修订**:
        // fallback fire 路径 internal.cliSessionId set 为 fallbackId (cli sid 维度),
        // applicationSid 切换走 isNewSpawn 分支保护(spawn 主路径 fallbackId === tempKey, applicationSid
        // 切到 fallbackId;resume 路径 fallbackId === resumeId === applicationSid,internal.applicationSid
        // 已是 opts.resume 不需切)。这里 fallback 也走同款 isNewSpawn 三分支语义。
        const fallbackId = resumeId ?? tempKey;
        const isNewSpawnFallback = !resumeId;
        logger.warn(`[sdk-bridge] no SDKMessage in 30s, falling back to id ${fallbackId}`);
        internal.cliSessionId = fallbackId;
        if (isNewSpawnFallback) {
          // spawn 主路径 fallback (fallbackId === tempKey === applicationSid 初值): 切到 fallbackId 后冻结
          // 此时 fallbackId === tempKey,applicationSid 已是 tempKey 不需切 — D2 spawn rename 仍由后续
          // sessions Map mutate 触发(下方 if (tempKey !== fallbackId) 在此 case false 不进 mutate)
          internal.applicationSid = fallbackId;
        }
        // resume 路径 fallback: fallbackId === resumeId === applicationSid,internal.applicationSid
        // 已是 opts.resume 全程不变 (S2 jsdoc resume/fallback 类型)
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
          effectiveResumeCliSid,
          resumeMode,
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
    applicationResumeId?: string,
    effectiveResumeCliSid?: string,
    /**
     * **plan reverse-rename-sid-stability-20260520 §A.4-pre S1 R3 HIGH-G + R7 HIGH-R7-1**:
     * jsonl-missing fallback 走 resumeMode='fresh-cli-reuse-app' 时,caller 传 resumeId=applicationSid
     * 但 SDK 不带 resume 起 fresh CLI thread。consume 内部需要识别此 case 不走 spawn 主路径
     * D2 rename — 故传 resumeMode 让 isNewSpawn 三分支保护正确判定。
     */
    resumeMode?: 'resume-cli' | 'fresh-cli-reuse-app',
  ): Promise<string | null> {
    let realId: string | null = null;
    try {
      for await (const msg of internal.query) {
        const m = msg as { type: string; session_id?: string; [k: string]: unknown };

        // 第一次拿到 session_id：完成 key 切换 + 通知 createSession
        if (!realId && typeof m.session_id === 'string' && m.session_id) {
          const isNewSpawn = !applicationResumeId && resumeMode !== 'fresh-cli-reuse-app';
          if (
            isNewSpawn &&
            (internal.expectedClose || this.ctx.sessions.get(tempKey) !== internal)
          ) {
            logger.warn(
              `[sdk-bridge] first-id arrived after new session was closed; ` +
                `incoming=${m.session_id} temp=${tempKey}; skipping mutation`,
            );
            continue;
          }
          // **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 2.2 修法 (H1+H2 race 双保险 (B) consume guard)**:
          // R2 plan-review HIGH-A 修订：用临时 incomingId 局部变量 — guard 命中时**不能**直接
          // 写入 realId 然后 continue。如果 `realId = m.session_id` 后 continue 跳出当前 frame,
          // 但后续 frame 仍走正常 first-id 路径切 sessions Map / 调 rename,finally cleanup 同款撞 race。
          //
          // **race 真正护栏**：fallback fire 后 internal.cliSessionId 已被 set 为 fallbackId
          // (Phase 2.1 + A1-HIGH-2 修法,line 195)。此时 SDK in-flight burst 仍 emit late first-id frame
          // (spike1 case A 实证)→ guard 命中 (cliSessionId !== incomingId) → console.warn + continue,
          // **不**改 sessions Map / **不**改 realId / **不**调 renameSdkSession,确保 fallbackId 上的
          // record 不丢失。后续 frame 事件派发恒用 internal.applicationSid (line 385 单一来源,fallback
          // 路径下已切 fallbackId),late first-id 仅跳过 mutation 不影响派发维度。
          //
          // 不变量 1: race 修法 land 后 fallback fire / createSession throw 路径 SDK 真发的 first
          // id frame 不能覆盖 fallback 已设的 fallbackId / 已 mutate 的 sessions Map。
          const incomingId = m.session_id;
          if (internal.cliSessionId !== null && internal.cliSessionId !== incomingId) {
            logger.warn(
              `[sdk-bridge] late first-id arrived after fallback; ` +
                `incoming=${incomingId} fallback=${internal.cliSessionId}; skipping mutation`,
            );
            // realId 保持 null,后续 frame 事件派发恒用 internal.applicationSid (line 385),
            // sessions Map 不被 late id 改写,translate 仍 emit 但不撞 sessions Map race。
            continue;
          }
          const isNormalResume = !!applicationResumeId && resumeMode !== 'fresh-cli-reuse-app';
          const requestedCliSid = effectiveResumeCliSid;
          const isPhantomResumeId =
            isNormalResume &&
            requestedCliSid === internal.applicationSid &&
            incomingId !== internal.applicationSid;

          if (isPhantomResumeId) {
            // Claude Code 2.1.160+ can emit a fresh run id in the SDK init/status frame while
            // the transcript is still appended to applicationSid.jsonl. Persisting that run id as
            // cli_session_id makes the next restart/recover resume a non-existent jsonl file.
            realId = internal.applicationSid;
            internal.cliSessionId = internal.applicationSid;
            logger.warn(
              `[sdk-bridge] CLI resume emitted runtime id ${incomingId} for application sid ` +
                `${internal.applicationSid}; preserving application sid as cli_session_id`,
            );
            onFirstId(realId);
          } else {
            realId = incomingId;
            internal.cliSessionId = realId;
          }
          // **plan reverse-rename-sid-stability-20260520 §A.4-pre S3 R4 HIGH-R4-1 + R7 HIGH-R7-1
          // isNewSpawn 三分支保护**: 区分 spawn 主路径 vs resume/fallback 路径,防 fallback 路径
          // 误进 spawn rename 分支破 5 处契约。S6 fork detect 比较 effectiveResumeCliSid 在本块 if 之后处理。
          //
          // - spawn 主路径 (无 opts.resume + resumeMode='resume-cli' default): tempKey !== realId
          //   时 D2 spawn bootstrap rename 保留,sessions Map 切到 realId + applicationSid 切到 realId 冻结
          // - resume / fallback 路径 (有 opts.resume): applicationSid 全程不变 (S2 jsdoc),sessions Map
          //   key 已在 ctor 时 set 为 applicationSid (sub-commit A-5 fix); jsonl-missing fallback
          //   (resumeMode='fresh-cli-reuse-app') 走 sessionManager.updateCliSessionId 黑名单链
          //   (R5 HIGH-R5-1 + R6 MED-R6-1 修订: DB 写经 manager 包装,manager 内部读 oldCliSid 进黑名单 60s)。
          //   normal resume (resumeMode='resume-cli') 不在此处写 DB,交给 S6 fork detect 处理(无 fork
          //   时 cliSid 同值无需写,真实 fork 时由 S6 经 manager 黑名单链写入)。
          if (!isPhantomResumeId && tempKey !== realId) {
            if (isNewSpawn) {
              // spawn 主路径: D2 spawn bootstrap rename 保留 + applicationSid 切到 realId 冻结
              this.ctx.sessions.delete(tempKey);
              this.ctx.sessions.set(realId, internal);
              internal.applicationSid = realId;  // ← spawn 路径 applicationSid 切到 first realId 后冻结 (S2 jsdoc)
              // fallback 路径：createSession 已用 tempKey 调过 claimAsSdk 并 emit 了 session-start，
              // sessionManager 已写入了一条以 tempKey 为 id 的「内」会话占位行（含 permission_mode 等）。
              // 用 rename 而不是 delete + new：保留 tempKey 行的内容（包括用户已选过的 permission_mode、
              // 已落库的事件 / 文件改动 / 总结），整体迁到 realId。renderer 侧通过 session-renamed
              // 事件同步迁移 selectedId / by-session 状态，不会被踢回主界面。
              // REVIEW_7 M3：renameSdkSession 内聚 sdkOwned claim 转移，调用方不再手工 release+claim。
              sessionManager.renameSdkSession(tempKey, realId);
            } else if (resumeMode === 'fresh-cli-reuse-app') {
              // **plan §A.4-pre S3 R5 HIGH-R5-1 + R6 MED-R6-1 修订**:
              // jsonl-missing fallback: opts.resumeCliSid undefined,S6 fork detect 不触发(短路);
              // DB cli_session_id 列 + OLD_CLI_ID 黑名单交给 sessionManager.updateCliSessionId
              // 让 manager 内部读 oldCliSid + recentlyDeleted.set(oldCliSid, 60s) 防迟到 hook event
              // 复活幽灵 record (不变量 5)。
              sessionManager.updateCliSessionId(internal.applicationSid, realId);
            }
            // normal resume 路径 (isNewSpawn=false + resumeMode='resume-cli'): applicationSid 全程不变;
            // sessions Map key 已 ctor 时 set 为 applicationSid 不需要 mutate;
            // DB cli_session_id 列写入交给 S6 fork detect 处理(下方 if (resumeId && resumeId !== realId))。
          }

          // **plan reverse-rename-sid-stability-20260520 §A.4-pre S6 R6 HIGH-R6-1 + R7 HIGH-R7-1 + R7 MED-R7-1 修订**:
          // fork detect 比较 effectiveResumeCliSid (caller resolve 后的 cli sid 维度,不 short-circuit)
          // 而非旧 resumeId (applicationSid 维度,反向 rename 后 appSid != cliSid 必触发误判)。
          // 触发后调 sessionManager.updateCliSessionId(internal.applicationSid, realId) 走 manager
          // 黑名单链 (R5 HIGH-R5-1 + R6 MED-R6-1 修订:DB 写必须经 sessionManager 包装,manager 内部
          // 读 oldCliSid + recentlyDeleted.set(oldCliSid, ...) 黑名单 60s)。
          //
          // **R7 MED-R7-1 + CHANGELOG_224 修订**: condition 用 requestedCliSid
          // (caller waitForRealSessionId 透传 effectiveResumeCliSid),并跳过 phantom runtime id。
          // CHANGELOG_27 / REVIEW_6：CLI 在 SDK streaming input + resume + 新 prompt 下隐式 fork —
          // 实测铁证：resume=OLD_ID, prompt='ping' → first session_id=NEW_ID (≠ OLD_ID),
          // CLI 内置 fork 与 SDK 文档「forkSession 默认 false 不 fork」不一致。
          if (
            !isPhantomResumeId &&
            resumeMode !== 'fresh-cli-reuse-app' &&
            requestedCliSid &&
            requestedCliSid !== realId
          ) {
            logger.warn(
              `[sdk-bridge] CLI forked: requested cli sid=${requestedCliSid} but got realId=${realId}; ` +
                `updating cli_session_id column on application sid ${internal.applicationSid} (走 manager 黑名单链)`,
            );
            // **R5 HIGH-R5-1 + R6 MED-R6-1 + R7 MED-R7-1 修订**: 走 sessionManager.updateCliSessionId
            // 而非 renameSdkSession (反向 rename 不动 sessions.id);第一参数 internal.applicationSid
            // (app sid 维度,与 R3 MED-R3-1 修订 update 第一参数对齐)。
            // 不变量 1 (sessions.id 永不变) + 不变量 2 (cli_session_id 6 处反向 rename 路径下变化) +
            // 不变量 5 (黑名单链 60s 防迟到 hook event 复活幽灵 record)。
            sessionManager.updateCliSessionId(internal.applicationSid, realId);
          }

          if (!isPhantomResumeId) onFirstId(realId);
        }

        // **plan reverse-rename-sid-stability-20260520 §A.4-pre S4 R4 HIGH-H 修订**:
        // event sid 派发统一用 internal.applicationSid (D7 不变量 3 wire prefix [sid] 100% 写 sessions.id)。
        // applicationSid 在 spawn 主路径 first realId 到达时切到 realId 后冻结 (S2 + S3 R4 HIGH-R4-1
        // isNewSpawn 分支保护),resume/fallback 路径 ctor 时 = opts.resume 全程不变。
        const sid = internal.applicationSid;
        translateSdkMessage(this.ctx.emit, sid, m, internal);
      }
    } catch (err) {
      logger.warn(`[sdk-bridge] query loop ended`, err);
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
        // **R4 HIGH-H 修订 同 S4 sid 派发**:catch 里也用 internal.applicationSid (替代旧三档链)
        const sid = internal.applicationSid;
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
      try {
        // **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 2.4 + R4 HIGH-H 修订**:
        // sid 三档链统一改用 internal.applicationSid (S2 jsdoc 双阶段化保证 spawn 路径切到 realId
        // 后冻结 / resume 路径全程不变),不再三档链 fallback。fallback 路径下 internal.cliSessionId 已是
        // fallbackId (Phase 2.1) + internal.applicationSid 已切 (R4 HIGH-R4-1 isNewSpawn 修订),
        // sessions Map key 是 applicationSid,cleanup 用 applicationSid 删除 (sessions.delete + releaseSdkClaim)。
        const sid = internal.applicationSid;
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
        resetTurnUsageAccounting(internal);
        clearLiveTokenEstimate(internal, sid);
        this.ctx.emit({
          sessionId: sid,
          agentId: AGENT_ID,
          kind: 'session-end',
          payload: { reason: 'sdk-stream-ended' },
          ts: Date.now(),
          source: 'sdk',
        });
        if (this.ctx.sessions.get(sid) === internal) {
          this.ctx.sessions.delete(sid);
        }
        if (this.ctx.sessions.get(tempKey) === internal) {
          this.ctx.sessions.delete(tempKey);
        }
        sessionManager.releaseSdkClaim(sid);
        // **REVIEW_75 MED (reviewer-codex + lead 代码链实测)**:自然 stream end 也要释放 CLI sid claim。
        // 根因:create-session-sdk-query.ts:179 拿到 realId 后无条件 claimAsSdk(realId)。resume fork /
        // fresh-cli-reuse-app 路径下 realId 是 CLI sid 维度,internal.applicationSid 保持应用稳定 sid
        // (反向 rename 不动 applicationSid)→ realId !== applicationSid。修前 finally 仅
        // releaseSdkClaim(applicationSid),CLI sid 的 claim 永留 #sdkOwned。
        // **真实后果(REVIEW_77 reviewer-claude INFO 精确化)**:核心是 #sdkOwned Set 条目泄漏 —
        // fork/fresh 每会话留一条 CLI sid claim 永不释放,累积到应用重启。至于「迟到 hook event 被
        // 丢弃」只在 ingest 3a `findByCliSessionId` 不命中(cli_session_id 列没写该 cliSid)时才靠
        // cliSid claim 顺带挡;3a 命中时 event.sessionId 已被覆写成 applicationSid,dedupOrClaim
        // 检查的是 hasSdkClaim(applicationSid) 不是 cliSid claim — 故 leak 才是修法主因,非 dedup。
        // 只有 closeSession→runCloseSessionCleanup(pending-cancellation.ts:107-115)才释放三面 id,
        // 自然 sdk-stream-ended 路径覆盖不到。修法:mirror runCloseSessionCleanup 的「释放」语义 —
        // cliSessionId 与 sid/tempKey 都不同时(典型 fork/fresh)额外释放 CLI sid claim。
        // **刻意只 mirror release 不 mirror 黑名单**(REVIEW_77 reviewer-claude LOW 裁决):自然
        // sdk-stream-ended → advanceState 设 dormant(允许用户随时 resume 复活),与 closeSession→closed
        // (禁止复活,故 pending-cancellation.ts:121-127 才加 markRecentlyDeleted 黑名单)语义相反 —
        // dormant 路径加黑名单会误挡 60s 内合法 resume(manager.ts:320 isRecentlyDeleted 早返不区分
        // source),故此处与 applicationSid release(L456,黑名单同样不加)一致只释放不拉黑。
        const cliSid = internal.cliSessionId;
        if (cliSid && cliSid !== sid && cliSid !== tempKey) {
          sessionManager.releaseSdkClaim(cliSid);
        }
      } finally {
        internal.resolveStreamDrained();
      }
    }
    return realId;
  }
}
