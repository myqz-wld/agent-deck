/**
 * Phase 4 Step 4.3 recoverAndSend 主体 — codex 端断连自愈 + jsonl 兜底实现。
 *
 * **抽出动机**: SessionRecoverer 是 class 但 recoverAndSend ~280 LOC 巨型 method,
 * 抽到独立 free function 让 facade SessionRecoverer 真薄(class shell + thin delegate)。
 * `this.X` field 改为 deps interface 注入 (与 hand-off-session / archive-plan-impl 经验同款)。
 *
 * **执行序列**(对应 facade recoverer.ts 修前 L186-456 位置):
 * 1. inflight check — 同 sessionId 重入时等单飞完成,attachments 透传后 sendThunk live 路径
 * 2. sessionRepo.get 兜底 — record 不在 throw 'not found'
 * 3. text length cap — MAX_MESSAGE_LENGTH 与 messageRepo cap 全局对齐 (R2 MED-1 修法位置前移)
 * 4. emit user message — 立即与 live 主路径时机对称 (REVIEW_58 HIGH + R2 MED-1 收口)
 * 5. cwd precheck — cwd 不存在走 findFallbackCwd 启发式,真没救 emit error + throw
 * 6. recovering Map set (single-flight 锁,REVIEW_60 MED-codex-1 修法 — 锁覆盖整链)
 * 7. IIFE 内: archived unarchive + placeholder dedup + jsonl-fallback / 正常 resume
 * 8. catch: emit "自动恢复失败" + throw
 *
 * **state 所有权**:
 * - `recovering` Map: **SHARED** 与 facade.restartController 同份 ref (symmetry-plan P2 HIGH-A)
 * - `placeholderEmittedAt` Map: **recoverer 独占** (5s dedup,REVIEW_17 R3 同款)
 */
import type { SessionRecord, UploadedAttachmentRef } from '@shared/types';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { AGENT_ID, MAX_MESSAGE_LENGTH } from '../constants';
import {
  buildCodexCwdMissingErrorText,
  buildCodexCwdFallbackInfoText,
} from '../codex-recoverer-messages';
import { maybeCodexJsonlFallback } from '../codex-jsonl-fallback';
import { toCodexModelOverride } from '../../sdk-model';
import { RecoveryCancelledError, isRecoveryCancelledError } from '@main/adapters/shared/recovery-cancelled';
import type { RecoverAndSendDeps } from './_deps';
import { PLACEHOLDER_DEDUP_MS } from './_deps';
import { isRetryingUniversalDelivery } from './universal-delivery';
import log from '@main/utils/logger';
import { isCodexThinkingLevel } from '@shared/session-metadata';
import type { CapturedRecoveryContinuation } from '@main/session/continuation-context/recovery';
import type { AdapterRecoveryDeliveryOptions } from '@main/adapters/enqueue-idempotency';

const logger = log.scope('codex-recoverer');

/**
 * **plan cross-adapter-parity-20260515 Phase B Step B.2 — 返回 Promise<string>**:
 * 返回 final session id(fallback path 返 newRealId / resume path 返 sessionId)。修前
 * `Promise<void>` waiter 等 inflight 后用 OLD sessionId 调 sendThunk → bridge.sendMessage
 * 内 sessions Map miss → 又进 recoverAndSend → sessionRepo.get(OLD) 已 rename DELETE → throw
 * "not found" — 用户体感「第二条消息消失」(REVIEW_40 R2 reviewer-codex MED parity 限制)。
 *
 * 修后 waiter 拿 finalId 调 sendThunk(finalId, text, atts),fallback path 走 NEW(主 recovery
 * 完成后 sessions Map 已 rename 同步)直接 push 进 NEW session;resume path finalId === sessionId
 * 行为零变化(codex 不 implicit fork,详 recoverer.ts L34 节注释)。失败路径 reject 仍透传(catch 静默
 * fallback finalId=sessionId 让等待者再撞一次触发新一轮 recovery,plan §B.5 设计)。
 */
export async function recoverAndSendImpl(
  sessionId: string,
  text: string,
  attachments: UploadedAttachmentRef[] | undefined,
  options: AdapterRecoveryDeliveryOptions | undefined,
  deps: RecoverAndSendDeps,
): Promise<string> {
  const inflight = deps.ctx.recovering.get(sessionId);
  if (inflight) {
    // 等同一恢复完成 → 然后正常走完整 sendMessage 流程把这条新 text push 进 sessions。
    // catch 静默：第一波恢复失败时第二条等待者自己再走 sendMessage，要么进新一轮 recovery，
    // 要么拿到真错（与 claude 同款）。
    //
    // plan cross-adapter-parity-20260515 Phase B.2: try/catch 拿 finalId 让 sendThunk 用 NEW
    // sid 不撞 not found(plan §B.5 设计:reject 时 finalId=sessionId 让等待者再撞一次触发
    // 新一轮 recovery,与原行为一致)。
    //
    // **REVIEW_99 R3 cancellation-epoch (codex 第 4 点 — 最易漏的 single-flight waiter 路径,对称
    // claude)**:主 recovery 因「恢复期间用户再次 close」abort 时 IIFE throw RecoveryCancelledError。
    // 若仍走旧 `catch { finalId = sessionId }` → 等待者 sendThunk(sessionId) → 重新触发 recovery
    // 把刚 close 的会话又 revive。修法:special-case sentinel → 等待者**不** retry / 不 sendThunk,
    // 静默返 sessionId。非 sentinel 真失败仍走旧 retry 路径(plan §B.5 不变)。
    let finalId: string;
    try {
      finalId = (await inflight) as string;
    } catch (err) {
      if (isRecoveryCancelledError(err)) {
        // 主 recovery 被 close abort → 等待者不 retry(否则 revive closed),静默结束
        return sessionId;
      }
      // 第一波恢复已失败(非 cancel),第二条用 OLD 再撞一次触发新一轮 recovery 路径
      finalId = sessionId;
    }
    // attachments 透传（与 claude HIGH-1 修法同款）：第二条等待者带的图属于「自己这条 message」
    // 与第一条独立，必须走完整 sendMessage 路径。
    if (options?.sendAfterRecovery) {
      await options.sendAfterRecovery(finalId);
    } else {
      await deps.sendThunk(finalId, text, attachments);
    }
    return finalId;
  }

  const rec: SessionRecord | null = sessionRepo.get(sessionId);
  if (!rec) {
    // 没有历史 record：彻底无法恢复，保留原 throw 信号兼容上层处理
    throw new Error(`session ${sessionId} not found`);
  }

  // **REVIEW_81 MED 修法（reviewer-claude + reviewer-codex 双方独立共识 + lead 全链 trace；
  // C2 claude MED-1 / REVIEW_76 的 codex 对称缺口，codex 侧此前未跟修）**:
  // 入口先捕获 wasClosed（在下方 line ~134 emit user message 复活之前读）。
  // closed 会话走入口 emit user message → ingest → ensure（manager.ts:251-258 `if existing.lifecycle
  // === 'closed'` → upsert lifecycle:'active' + emit session-upserted）**复活成 active**；随后两条
  // 失败路径（cwd 全 miss throw / createSession reject outer catch rethrow）都不回滚 → closed 会话
  // 复活成 active 但无 SDK live session = dead-active 幽灵（SessionList 死卡片）。codex 全程只读
  // rec.archivedAt（unarchive）从不读 rec.lifecycle，与 claude 修前一模一样（archived 有对称防护、
  // closed 没防）。两条失败路径 `if (wasClosed) sessionManager.markClosed(sessionId)` 回滚。
  // 用 markClosed（manager.ts:349 已暴露，guard 接受 active→closed）不用 raw setLifecycle
  // （REVIEW_56 第四入口反模式 — 绕过 clear marker + leave team + UI emit）。
  const wasClosed = rec.lifecycle === 'closed';
  const sdkModel = toCodexModelOverride(rec.model);
  const sdkThinking = isCodexThinkingLevel(rec.thinking) ? rec.thinking : undefined;
  const retryingUniversalDelivery = isRetryingUniversalDelivery(sessionId, text);

  // MAX_MESSAGE_LENGTH 字符长度上限（与 messageRepo cap 全局对齐）。
  // 恢复路径不能绕过此防线（防超长 prompt 当作恢复路径首条消息送进 createSession）。
  //
  // R2 MED-1 修法 (reviewer-codex + reviewer-claude 双方独立提出真问题 — 对称 claude):
  // 提前到 sessionRepo.get 后 + cwd precheck 之前 — 让下面 emit user message 也能提前到
  // cwd precheck 之前覆盖 cwd 全 miss throw 路径(防 user message 在 throw 后才 emit 永不入库)。
  const len = text.length;
  if (len > MAX_MESSAGE_LENGTH) {
    throw new Error(
      `单条消息 ${len.toLocaleString()} 字符超过 ${MAX_MESSAGE_LENGTH.toLocaleString()} 字符上限。请精简或拆分发送。`,
    );
  }

  // Resolve the effective cwd without emitting yet. Recovery capture freezes the complete target
  // runtime, so a cwd fallback must be reflected in that snapshot. User/cwd events keep their
  // historical ordering below: current user first, then fallback info or error.
  let effectiveCwd = rec.cwd;
  let cwdUnavailable = false;
  let cwdResolutionError: unknown;
  try {
    if (!deps.cwdExistsThunk(rec.cwd)) {
      const fallback = deps.findFallbackCwd(rec.cwd);
      if (fallback === null) cwdUnavailable = true;
      else effectiveCwd = fallback;
    }
  } catch (error) {
    // Preserve the established early user-event behavior even if a filesystem test seam fails.
    cwdResolutionError = error;
  }

  // Critical ordering invariant: copy all mutable source rows to connection-local SQLite TEMP
  // storage before emitting the current user event. A capture failure is retained rather than
  // thrown here so native provider resume can still proceed and the user's message remains visible.
  let recoveryCapture: CapturedRecoveryContinuation | null = null;
  let recoveryCaptureError: unknown;
  try {
    recoveryCapture = deps.captureRecovery(rec, {
      cwd: effectiveCwd,
      model: sdkModel ?? null,
      thinking: sdkThinking ?? null,
    });
  } catch (error) {
    recoveryCaptureError = error;
    logger.warn(`[codex-bridge] immutable recovery capture failed for ${sessionId}:`, error);
  }

  const cleanupCapture = (): void => {
    if (!recoveryCapture) return;
    try {
      deps.cleanupRecovery(recoveryCapture);
    } catch (error) {
      logger.warn(`[codex-bridge] recovery spool cleanup failed for ${sessionId}:`, error);
    }
  };

  // REVIEW_58 HIGH ✅ + R2 MED-1 收口修法 (deep-review 双方共识真问题 — 对称 claude recoverer.ts):
  // 立即 emit user message 与 live 主路径 sendMessage `index.ts:778-793` 时机对称。
  // 修前 codex-cli sendMessage `if (!s)` 分支只委托 recoverAndSend → emit user message
  // 责任全下放下游 createSession resume path (index.ts:539-556) / new path (thread-loop)
  // 跨 SDK 实际 spawn 时序 → 用户截图实测 user message bubble 消失。
  //
  // **R2 MED-1 修订**:emit 位置在 cwd precheck **之前**(替代 R1 在 cwd precheck 之后),
  // 让 cwd missing fallback 全 miss throw 路径也保留 events 入库 — 用户看到 cwd missing
  // error 红字 + 自己的 message bubble 仍在,帮助决策。否则修了用户截图 bug 但 cwd 全 miss
  // 边角 case 仍漏。
  //
  // 收口到 recovery 入口让用户体感与 live 主路径一致 + 失败/边界路径保留 events。
  // 下游 createThunk 显式传 skipFirstUserEmit:true 让 createSession resume path 跳过重复 emit。
  // 等待者 inflight path 无需改 — sendThunk 内部走 sendMessage live 主路径自己 emit。
  try {
    if (
      !retryingUniversalDelivery &&
      !options?.userEventAlreadyPersisted &&
      !options?.initialEnqueueOptions?.deferUserEventUntilTurnStart
    ) deps.ctx.emit({
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
  } catch (error) {
    cleanupCapture();
    throw error;
  }

  // **REVIEW_99 R3 cancellation-epoch baseline (codex 第 1 点 — entry emit 之后捕获,对称 claude
  // recover-and-send-impl)**:closed 合法 resume 时上面 entry emit(source:'sdk')同步走 ingest →
  // ensure closed→active 复活,**不算 close**;baseline 放 emit 前会把入口前的旧 close 混进。entry
  // emit 后捕获 → baseline 锁定「本次 recovery 起点的 close 计数」,多检查点(codex-jsonl-fallback
  // await 后 + createSession pre-registration await 后)比对 `getCloseEpoch !== baseline` 只对**恢复
  // 期间新发生的 close**命中。epoch 替代旧 `closed && !wasClosed` lifecycle 快照(漏「恢复期间第二次
  // close」+ 撞集成测试 mock 不 revive gap)。详 manager/_deps.ts closeEpoch jsdoc + claude 对称实现。
  let closeEpochBaseline: number;
  try {
    closeEpochBaseline = sessionManager.getCloseEpoch(sessionId);
  } catch (error) {
    cleanupCapture();
    throw error;
  }
  const cancelGuard = (): boolean => {
    if (!sessionRepo.get(sessionId)) return true; // record await 期间被删 → abort
    return sessionManager.getCloseEpoch(sessionId) !== closeEpochBaseline;
  };

  // CHANGELOG_99 cwd 失效根治（与 claude 同款 R1 fix MED-2 顺序：cwd 校验 → unarchive,
  // 避免 archived session cwd fallback 失败前被 unarchive 成 active 但实际死路一条）。
  //
  // symmetry-plan P3 R2-2 (reviewer-claude MED-G):cwd fallback 后 effectiveCwd 仍可走正常 resume
  // (codex jsonl 独立于 cwd,详 recoverer.ts L38-40 节注释),不再像 claude 那样强制 fresh thread。
  if (cwdResolutionError !== undefined) {
    cleanupCapture();
    if (wasClosed) sessionManager.markClosed(sessionId);
    throw cwdResolutionError;
  }
  if (cwdUnavailable) {
    // 真没救：emit 清晰错误,throw,不进 placeholder 路径。
    // **不 unarchive**（archived 状态下 throw,session 仍归档，用户在 SessionList "已归档"
    // 列表能看到清晰错误信息 — 与 claude MED-2 fix 同款）
    try {
      deps.ctx.emit({
        sessionId,
        agentId: AGENT_ID,
        kind: 'message',
        payload: {
          text: buildCodexCwdMissingErrorText(rec.cwd),
          error: true,
        },
        ts: Date.now(),
        source: 'sdk',
      });
    } catch (error) {
      cleanupCapture();
      if (wasClosed) sessionManager.markClosed(sessionId);
      throw error;
    }
    // **REVIEW_81 MED 修法**: closed 会话被入口 emit user message 复活成 active，cwd 全 miss
    // 此路径 throw 前不起 createSession（dead-active 幽灵）。wasClosed 时走 markClosed 再关闭
    // （与 archived 路径「cwd-miss 时保持归档」对称 — closed 也应保持 closed）。markClosed 放
    // error message emit 之后：error emit（source:'sdk'）过 ingest 时 record 已 active →
    // ensure 走 manager.ts:261 `return existing` 不再复活 → 顺序安全（与 claude C2 同款结论）。
    cleanupCapture();
    if (wasClosed) sessionManager.markClosed(sessionId);
    throw new Error(
      `session ${sessionId} cwd does not exist and no fallback available: ${rec.cwd}`,
    );
  }
  if (effectiveCwd !== rec.cwd) {
    // emit cwd fallback info 让用户知情。
    // symmetry-plan P3 R2-2 (reviewer-claude MED-G):text 改正确反映 codex 实际行为 — codex jsonl
    // 在 ~/.codex/sessions/<YYYY>/<MM>/<DD>/ date-based 目录,**完全独立于 cwd**(与 claude
    // ~/.claude/projects/<encoded-cwd>/<sid>.jsonl 不同 — 详 recoverer.ts L38-40 节注释)。
    // 修前 text 错说「jsonl 在原 cwd 下,本会话续聊从 fresh thread 开始」与代码自身注释自相矛盾。
    // 修后 cwd fallback 不再强制 fresh thread(下方 fallback 条件改 `if (!jsonlExistsThunk)`),
    // codex resumeThread + workingDirectory:effectiveCwd 正常进 SDK 保留对话历史。
    // 用户提示重点是「文件引用可能不再指向同一文件」(SDK turn 内引用 cwd 内相对路径会失效)。
    try {
      deps.ctx.emit({
        sessionId,
        agentId: AGENT_ID,
        kind: 'message',
        payload: {
          text: buildCodexCwdFallbackInfoText(rec.cwd, effectiveCwd),
        },
        ts: Date.now(),
        source: 'sdk',
      });
    } catch (error) {
      cleanupCapture();
      if (wasClosed) sessionManager.markClosed(sessionId);
      throw error;
    }
    logger.warn(
      `[codex-bridge] cwd fallback for ${sessionId}: ${rec.cwd} → ${effectiveCwd}`,
    );
  }

  // REVIEW_60 MED-codex-1 修法(reviewer-codex R1 MED 单方 finding + lead 验证 — 对称 claude recoverer.ts):
  // recovering Map 单飞锁必须在 cwd precheck 之后、任何 await 之前同步 set,
  // 把 archived session unarchive + 占位 message dedup 整段移进 IIFE 让锁覆盖整链。
  // 旧 bug: inflight check L186 与 set L447 之间存在 `await sessionManager.unarchive(L319)`
  // 窗口,两个并发 sendMessage 打到同 archived session 时双方都通过 inflight check → 各自
  // 创建 IIFE → 双 createSession → 破坏「同 session 只允许一条 recovery in-flight」不变量。
  const p = (async (): Promise<string> => {
    try {
      // CHANGELOG_31：用户在 detail 里主动发消息触发 recoverAndSend = 显式表达「我又要聊它了」，
      // 自动取消归档（与 claude 同款）。manager.ts 立的「归档与 lifecycle 正交，不能因事件流自动
      // unarchive」约束针对的是 hook 触发路径，本路径是用户显式 UI 动作不冲突。
      // CHANGELOG_99 R1 fix MED-2 顺序：本段必须在 cwd precheck 之后 — 确认 cwd 能恢复再 unarchive,
      // 避免 cwd fallback 失败 throw 但 session 已被错误 unarchive。
      // REVIEW_60 MED-codex-1 修订:从 IIFE 外移到 IIFE 内,让 single-flight 锁覆盖此 await。
      if (rec.archivedAt !== null) {
        logger.warn(
          `[codex-bridge] recoverAndSend on archived session ${sessionId}, auto-unarchiving (user explicitly sending message)`,
        );
        await sessionManager.unarchive(sessionId);
      }

      // 占位 message：起 codex 子进程期间用户至少看到「在恢复」而不是哑巴 busy（与 claude 同款）。
      // 5s dedup 窗口防同 sessionId 短时间内反复 recover 重 emit 多条「⚠ Codex 通道已断开」噪声。
      // REVIEW_60 MED-codex-1 修订:从 IIFE 外移到 IIFE 内,与 unarchive 同款 single-flight 锁覆盖。
      const lastPlaceholderAt = deps.placeholderEmittedAt.get(sessionId);
      const nowTs = Date.now();
      if (
        !retryingUniversalDelivery &&
        (lastPlaceholderAt === undefined || nowTs - lastPlaceholderAt > PLACEHOLDER_DEDUP_MS)
      ) {
        deps.placeholderEmittedAt.set(sessionId, nowTs);
        // 顺手清掉过期 entry（避免 Map 无限涨）
        for (const [k, ts] of deps.placeholderEmittedAt) {
          if (nowTs - ts > PLACEHOLDER_DEDUP_MS) deps.placeholderEmittedAt.delete(k);
        }
        deps.ctx.emit({
          sessionId,
          agentId: AGENT_ID,
          kind: 'message',
          payload: { text: '⚠ Codex 通道已断开，正在自动恢复…' },
          ts: nowTs,
          source: 'sdk',
        });
      }

      // Codex history is date-indexed independently of cwd. Probe by native cli_session_id; only a
      // true miss invokes the provider-neutral continuation engine and a fresh provider thread.
      const fbResult = await maybeCodexJsonlFallback(
        {
          jsonlExistsThunk: deps.jsonlExistsThunk,
          createSession: deps.createThunk,
          emit: deps.ctx.emit,
          prepareRecovery: deps.prepareRecovery,
        },
        {
          sessionId,
          cliSessionId: rec.cliSessionId ?? null,
          startedAt: rec.startedAt,
          cwd: effectiveCwd,
          prompt: text,
          capture: recoveryCapture,
          captureError: recoveryCaptureError,
          provider: rec.runtimeProvider ?? undefined,
          codexSandbox: rec.codexSandbox ?? undefined,
          model: sdkModel,
          modelReasoningEffort: sdkThinking,
          extraAllowWrite: rec.extraAllowWrite ?? undefined,
          // plan codex-recover-network-dirs-parity-20260602：jsonl-missing fallback 起 fresh thread
          // 时透传 reviewer-codex spawn-time 持久化的 network/dirs（codex SDK runtime 真消费）。
          // `?? undefined`：false 保留 / null 跳过走 SDK 默认（与 codexSandbox/model 同款）。
          networkAccessEnabled: rec.networkAccessEnabled ?? undefined,
          additionalDirectories: rec.additionalDirectories ?? undefined,
          attachments,
          initialEnqueueOptions: options?.initialEnqueueOptions,
          // **REVIEW_99 R3 cancellation-epoch (替代 R2 isCancelledFn lifecycle 快照,对称 claude)**：
          // await shared continuation preparation 期间用户主动 close 会被 closeImpl 自增
          // close-epoch + 静默设 closed 但不 abort 在途 recovering promise；helper await 后重读本
          // thunk，**epoch 变了**（恢复期间新 close / scheduler 衰减 / delete）→ abort 不起 fresh
          // thread（否则 createSession first user message 触发 ensure closed→active 复活，反转用户显式 close）。
          // epoch 是「close 动作发生过没有」的直接信号,旧 `closed && !wasClosed` 漏「恢复期间第二次
          // close」+ 撞集成测试 mock 不 revive gap;cancelGuard 不依赖 lifecycle 快照天然绕开。
          // 详 manager/_deps.ts closeEpoch jsdoc + claude recover-and-send-impl 对称实现。
          isCancelledFn: cancelGuard,
        },
      );
      // **R2 HIGH 修法 + REVIEW_99 R3 cancellation-epoch 统一 abort 语义（对称 claude）**：abort
      // 优先于 fellBack/fall-through 判定。用户 await 窗口内 close（epoch 变）→ helper 返 aborted:true。
      // **R3 关键改动**：从 `return sessionId`(resolve)改 `throw RecoveryCancelledError`(reject)。
      // 原因(codex 第 4 点)：IIFE p 是 waiter 直接 await 的 Promise，resolve sessionId 会让并发等待者
      // 拿到 sessionId → sendThunk(sessionId) → 重新触发 recovery 把刚 close 的会话 revive。改 throw
      // sentinel → p reject → waiter special-case 跳过 retry / outer catch special-case 静默 return
      // sessionId(不 emit 错误)。统一所有 abort 路径走 sentinel-reject 一条收口。
      if (fbResult.aborted) {
        throw new RecoveryCancelledError(sessionId);
      }
      if (fbResult.fellBack) {
        // helper 已包办 emit + createSession,applicationSid 全程不变 (反向 rename §不变量)
        return fbResult.finalSessionId; // == sessionId
      }
      // fellBack=false → fall through 到下面正常 resume 路径 (jsonl 在,行为不变)

      // 正常 resume 路径：jsonl 在 + cwd 有 → 走 createSession({resume, prompt, codexSandbox, model, attachments})
      // 复用 createSession 内部全套 protocol。
      // plan cross-adapter-parity-20260515 Phase A Step A.7:extraAllowWrite 与 codexSandbox 同样
      // 显式透传(不同于 model 字段:Codex runtime v0.131.0+ 已 runtime 真生效;本字段仍仅持久化未消费)。
      // plan cross-adapter-parity-20260515 Phase B Step B.2 + REVIEW_41 MED-2 fix: 拿 handle
      // 反映真实 finalId(codex spike-A2 实测 resume 不 fork → handle.sessionId === sessionId,
      // 但保 future-proof 防 codex SDK 升级 / 行为变更,且与 claude resume path 对称)。
      const handle = await deps.createThunk({
        cwd: effectiveCwd,
        prompt: text,
        resume: sessionId,
        provider: rec.runtimeProvider ?? undefined,
        // **plan reverse-rename-sid-stability-20260520 §A.4-pre S6.5 R6 HIGH-R6-1 双方共识必修
        // (codex 对称 claude recoverer.ts:486)**:
        // 显式传 resumeCliSid = rec.cliSessionId ?? sessionId 防 caller 不传时 S6 fork detect
        // 短路;反向 rename 后 rec.cliSessionId 是 SDK 当前 thread sid (允许变化),sessionId 是
        // applicationSid (永远稳定)。
        resumeCliSid: rec.cliSessionId ?? sessionId,
        // 显式透传：resume 路径下 createSession 内部 sandboxMode fallback 也能从 sessionRepo
        // 反查到（详 codex-cli/sdk-bridge/index.ts:185-188 fallback chain），但显式透传更清晰
        // 一致 + 与 claude HIGH-1 处理方式对称 + 防 sessionRepo 边界 race。
        codexSandbox: rec.codexSandbox ?? undefined,
        model: sdkModel,
        modelReasoningEffort: sdkThinking,
        extraAllowWrite: rec.extraAllowWrite ?? undefined,
        // plan codex-recover-network-dirs-parity-20260602：正常 resume 重建 thread 时透传
        // reviewer-codex spawn-time 持久化的 network/dirs（codex SDK runtime 真消费 — 不透传则
        // recover 后 reviewer 失去 web search + 跨目录访问）。`?? undefined` false 保留 / null 跳过。
        networkAccessEnabled: rec.networkAccessEnabled ?? undefined,
        additionalDirectories: rec.additionalDirectories ?? undefined,
        attachments,
        initialEnqueueOptions: options?.initialEnqueueOptions,
        // REVIEW_58 HIGH ✅ 收口修法:recoverAndSend 入口已 emit user message,
        // createSession resume path 跳过重复 emit(详 recoverer.recoverAndSend emit user message 段注释)
        skipFirstUserEmit: true,
        // **REVIEW_99 R3 cancellation-epoch MED 修法 (post-guard 窗口,对称 claude)**：codex
        // createSession 内部 ensureCodex / resumeThread pre-registration 到 sessions.set 之间
        // (create-session-resume.ts:47 deps.sessions.set 之前)用户 close → 旧实现只在
        // codex-jsonl-fallback await 后查一次,这条窗口漏判 → ensure closed→active 复活幽灵。传
        // cancelCheck thunk 让 createSession 在 sessions.set 前查 epoch:变了 → throw sentinel abort。
        cancelCheck: cancelGuard,
      });
      // plan cross-adapter-parity-20260515 Phase B Step B.2 + REVIEW_41 MED-2 fix: 与 claude
      // resume path 对称返 handle.sessionId(codex 现实测不 fork 但写法 future-proof)。
      return handle.sessionId;
    } finally {
      cleanupCapture();
      deps.ctx.recovering.delete(sessionId);
    }
  })();
  deps.ctx.recovering.set(sessionId, p);

  try {
    // plan cross-adapter-parity-20260515 Phase B Step B.2: 返 finalId 给 caller(虽 bridge
    // sendMessage 当前 caller 不消费返回值,但等待者 path 经 inflight 拿同款 finalId)。
    return await p;
  } catch (err) {
    // **REVIEW_99 R3 cancellation-epoch 统一 abort 收口（对称 claude）**：sentinel special-case
    // 必须在 generic catch **之前**。所有 abort 路径(codex-jsonl-fallback aborted / normal-resume
    // createSession pre-registration guard)都让 p reject RecoveryCancelledError。此时 lifecycle 已
    // 是用户想要的 closed(close 真发生过 → epoch 已自增),**不** emit「自动恢复失败」错误文案、**不**
    // markClosed 回滚。p 本身 reject(让 waiter special-case 跳过 retry,codex 第 4 点),但本 first-caller
    // outer catch **静默 return sessionId**(不向 renderer 抛错 — 用户主动 close 不该看到红字)。
    if (isRecoveryCancelledError(err)) {
      logger.warn(
        `[codex-bridge] recover aborted (session closed during recovery): ${sessionId}`,
      );
      return sessionId; // 静默结束(lifecycle 已是用户想要的 closed,无需回滚 / 不抛错给 renderer)
    }
    // createSession 失败：占位 message 已经 emit，再补一条 error message 让用户看到原因
    if (!retryingUniversalDelivery) {
      deps.ctx.emit({
        sessionId,
        agentId: AGENT_ID,
        kind: 'message',
        payload: {
          text: `⚠ 自动恢复失败：${(err as Error)?.message ?? String(err)}`,
          error: true,
        },
        ts: Date.now(),
        source: 'sdk',
      });
    }
    // **REVIEW_81 MED 修法**: closed 会话被入口 emit user message 复活成 active，createSession
    // reject 后无 SDK live session（dead-active 幽灵）。wasClosed 时走 markClosed 再关闭。
    // 顺序：上面 error message emit（source:'sdk'）过 ingest 时 record 已 active → ensure 走
    // manager.ts:261 return existing **不再复活**（仅 closed 才复活）→ 回滚放 error emit 之后安全
    // （markClosed active→closed 一次到位，与 claude C2 反驳轮关键确证同款顺序坑结论）。
    if (wasClosed) sessionManager.markClosed(sessionId);
    throw err;
  }
}
