/**
 * SessionRecoverer.recoverAndSend free fn impl — Step 4.4 拆分子模块。
 *
 * **抽出范围**（原 recoverer.ts:243-544 ~302 LOC）：
 * - inflight path（双等待者 + try/catch finalId + sendThunk transparent）
 * - not-found short-circuit
 * - length cap validate
 * - immediate user message emit（REVIEW_58 HIGH + R2 MED-1 收口）
 * - cwd precheck + fallback（CHANGELOG_99）
 * - IIFE 单飞（unarchive + placeholder dedup + maybeJsonlFallback + normal resume）
 * - outer try/catch + emit error message
 *
 * **签名 / 约束**：
 * - 入参：sessionId / text / attachments + deps (RecoverAndSendDeps bundle)
 * - 返回：Promise<string> finalId（resume 路径 === sessionId, implicit fork 路径 === newRealId）
 * - 不变量保留：REVIEW_24 HIGH-2 length cap / REVIEW_58 HIGH user message emit 时机 /
 *   REVIEW_60 MED-codex-1 single-flight 锁覆盖整链 / REVIEW_17 R3 5s dedup /
 *   CHANGELOG_28/99/107 fallback 链 / plan reverse-rename-sid-stability §A.4-pre S6.5
 *
 * **抽出动机**：与 codex 端 recoverer/recover-and-send-impl.ts 同款 free fn 模式。
 * facade `recoverer.ts` SessionRecoverer.recoverAndSend 改 thin delegate ~5 LOC：
 * `return recoverAndSendImpl(sid, text, atts, this._buildDeps())`。
 */
import type { SessionRecord, UploadedAttachmentRef } from '@shared/types';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { AGENT_ID, MAX_MESSAGE_LENGTH, PLACEHOLDER_DEDUP_MS } from '../constants';
// **plan restart-controller-jsonl-precheck-20260521 §Step 3f 重构**:
// jsonl missing fallback 整段移到 jsonl-fallback.ts helper,recoverer 不再直接调
// prependHistorySummary / settingsStore / eventRepo / 4 个 jsonlMissing/cwdFallback 文案 builder
// (这 4 个 import 已删,改 maybeJsonlFallback 一行覆盖)。
import { maybeJsonlFallback } from '../jsonl-fallback';
import {
  buildCwdFallbackInfoText,
  buildCwdMissingErrorText,
} from '../recoverer-messages';
import type { RecoverAndSendDeps } from './_deps';
import log from '@main/utils/logger';

const logger = log.scope('claude-recoverer');

/**
 * recoverAndSend 主入口实现 — free fn，无 facade class 内部 state。
 *
 * 关键约束：
 * - 完整复用 createSession，让 expectSdkSession(cwd) → claimAsSdk(opts.resume) →
 *   dedupOrClaim B 分支兜底 → waitForRealSessionId 全套护栏按原样跑（任何捷径都
 *   会重打开「两条 active record」bug，CLAUDE.md「resume 优先」节）
 * - permissionMode 用户上次主动选过的值复原，不能默认 'default' 否则用户辛苦切到的
 *   plan / acceptEdits 被静默还原
 * - 历史 record 完全不存在时直接抛与原行为一致的 'not found'，让 IPC 把错原样透传 renderer
 *
 * **plan cross-adapter-parity-20260515 Phase B Step B.1 — 返回 Promise<string>**:
 * 返回 final session id(fallback path 返 newRealId / resume path 返 sessionId)。修前
 * `Promise<void>` waiter 等 inflight 后用 OLD sessionId 调 sendThunk → bridge.sendMessage
 * 内 sessions Map miss → 又进 recoverAndSend → sessionRepo.get(OLD) 已 rename DELETE → throw
 * "not found" — 用户体感「第二条消息消失」(REVIEW_40 R2 reviewer-codex MED parity 限制)。
 *
 * 修后 waiter 拿 finalId 调 sendThunk(finalId, text, atts),fallback path 走 NEW(主 recovery
 * 完成后 sessions Map 已 rename 同步)直接 push 进 NEW session;resume path finalId === sessionId
 * 行为零变化。失败路径 reject 仍透传(catch 静默 fallback finalId=sessionId 让等待者再撞一次
 * 触发新一轮 recovery,plan §B.5 设计)。
 */
export async function recoverAndSendImpl(
  sessionId: string,
  text: string,
  attachments: UploadedAttachmentRef[] | undefined,
  deps: RecoverAndSendDeps,
): Promise<string> {
  const inflight = deps.ctx.recovering.get(sessionId);
  if (inflight) {
    // 等同一恢复完成 → 然后正常走完整 sendMessage 流程把这条新 text push 进 sessions。
    // catch 静默：第一波恢复失败时第二条等待者自己再走 sendMessage，要么进新一轮 recovery，
    // 要么拿到真错。不要把第一波的错往第二条上抛 —— 调用方只关心自己这条的成败。
    //
    // plan cross-adapter-parity-20260515 Phase B.1: try/catch 拿 finalId 让 sendThunk 用 NEW
    // sid 不撞 not found(plan §B.5 设计:reject 时 finalId=sessionId 让等待者再撞一次触发
    // 新一轮 recovery,与原行为一致)。
    let finalId: string;
    try {
      finalId = (await inflight) as string;
    } catch {
      // 第一波恢复已失败,第二条用 OLD 再撞一次触发新一轮 recovery 路径
      finalId = sessionId;
    }
    // HIGH-1 修法：attachments 透传给第二条等待者 sendThunk。
    // 原版只 sendThunk(sessionId, text) 静默吞掉 attachments；
    // 这条等待者带的图属于「自己这条 message」与第一条独立，必须走完整 sendMessage 路径。
    await deps.sendThunk(finalId, text, attachments);
    return finalId;
  }

  const rec: SessionRecord | null = sessionRepo.get(sessionId);
  if (!rec) {
    // 没有历史 record：彻底无法恢复，保留原 throw 信号兼容上层处理
    throw new Error(`session ${sessionId} not found`);
  }

  // REVIEW_24 HIGH-2 follow-up：字符长度上限（与 messageRepo cap 全局对齐）。
  // 恢复路径不能绕过此防线（防超长 prompt 当作恢复路径首条消息送进 createSession）。
  //
  // R2 MED-1 修法 (reviewer-codex + reviewer-claude 双方独立提出真问题):
  // 提前到 sessionRepo.get 后 + cwd precheck 之前 — 让下面 emit user message 也能提前到
  // cwd precheck 之前覆盖 cwd 全 miss throw 路径(防 user message 在 throw 后才 emit 永不入库)。
  const len = text.length;
  if (len > MAX_MESSAGE_LENGTH) {
    throw new Error(
      `单条消息 ${len.toLocaleString()} 字符超过 ${MAX_MESSAGE_LENGTH.toLocaleString()} 字符上限。请精简或拆分发送。`,
    );
  }

  // REVIEW_58 HIGH ✅ + R2 MED-1 收口修法 (deep-review 双方共识真问题):立即 emit user message,
  // 与 live 主路径 `index.ts:520-535` sendMessage emit 时机对称。修前 sendMessage `if (!s)` 分支
  // 只委托 recoverAndSend → emit user message 责任全下放下游 `finalizeSessionStart` (在 await
  // waitForRealSessionId 之后才 emit) / `maybeJsonlFallback` (在 await ctx.createSession
  // 之后才 emit) / setTimeout 30s fallback / createSession catch 路径完全不 emit → 用户
  // 截图实测「⚠ SDK 通道已断开...」+ assistant「✅ 一轮完成」但用户的 message bubble 消失。
  //
  // **R2 MED-1 修订**:emit 位置在 cwd precheck **之前**(替代 R1 在 cwd precheck 之后),
  // 让 cwd missing fallback 全 miss throw 路径(目录被删 / 跨设备同步丢失 / 启发式全 miss)
  // 也保留 events 入库 — 用户体感:看到 cwd missing error 红字 + 自己的 message bubble 仍在,
  // 帮助决策(如归档 + 新建会话)。否则修了用户截图 bug 但 cwd 全 miss 边角 case 仍漏。
  //
  // 现把 emit 责任收口到 recovery 入口:
  // ① 用户体感与 live 主路径一致(先看到自己的 message,再看 placeholder「在恢复」)
  // ② 失败/边界路径(createSession catch / setTimeout fallback / cwd-missing 全 miss)
  //    都不会丢 user message — events 表保留完整对话历史
  // ③ 下游 createThunk / maybeJsonlFallback 显式传 skipFirstUserEmit:true 让 finalize /
  //    fallback helper 跳过重复 emit,避免双气泡
  // 等待者 inflight path(L234-254)无需改 — sendThunk 内部走 sendMessage live 主路径自己 emit。
  deps.ctx.emit({
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

  // CHANGELOG_99 cwd 失效根治:启发式 fallback (R1 fix MED-2:**移到 unarchive 之前**,
  // 避免 archived session 在 cwd fallback 失败前被 unarchive 成 active 但实际死路一条 —
  // 用户体感"刚归档的会话被自动恢复又死路")。
  //
  // sessionRepo.cwd 已不存在(典型场景:K2 老 session cwd=worktree 后 worktree 被 archive_plan
  // 删 / 用户手动 git worktree remove / 跨设备同步丢目录 / 误删等)。
  //
  // 走 jsonl missing fallback 同款下游路径:createThunk 不带 resume + 后置 renameSdkSession
  // (CHANGELOG_28 已成熟;CLI 历史失但应用层 events/file_changes/summaries 子表保留)。
  //
  // 找不到 fallback(启发式 1 & 2 全 miss)→ emit error + throw,**不**emit「正在自动恢复」
  // placeholder(误导:明明不可能恢复)。
  let effectiveCwd = rec.cwd;
  let cwdFellBack = false;
  if (!deps.cwdExistsThunk(rec.cwd)) {
    const fallback = deps.findFallbackCwdThunk(rec.cwd);
    if (fallback === null) {
      // 真没救:emit 清晰错误,throw,不进 placeholder 路径
      // **不 unarchive**:archived 状态下 throw,session 仍归档,用户在 SessionList "已归档"
      // 列表能看到清晰错误信息(MED-2 fix:之前 unarchive 在前 → throw 后 session 变 active 但死路)
      deps.emitFallbackMessageThunk(sessionId, buildCwdMissingErrorText(rec.cwd), { error: true });
      throw new Error(
        `session ${sessionId} cwd does not exist and no fallback available: ${rec.cwd}`,
      );
    }
    effectiveCwd = fallback;
    cwdFellBack = true;
    // 主动告诉用户 fallback 发生了 + 用了哪个目录(不打 error,info 性质)
    // CHANGELOG_107 Step 4: 删去「CLI 内部对话历史(jsonl)将丢失」字眼,让后续
    // prependHistorySummary 决定丢失 / 续上(成功 → inner 分支 emit「LLM 摘要已注入」;
    // 失败 → inner 分支 emit「将丢失,请补背景」)。outer 只 emit cwd 切换 fact,
    // 不预判 jsonl 命运,避免「outer 说将丢 + inner 说不丢」前后矛盾误导用户。
    // REVIEW_36 R2 HIGH-B 修法：补 sandbox 写权限边界变化提示。fallback 后 SDK 子进程
    // chdir effectiveCwd，sandbox.allowWrite=[effectiveCwd, /tmp, ~/.cache] 自动跟着切到
    // fallback 目录 → workspace-write 档下写权限边界**可能扩大**（典型：原 worktree 写
    // `/Users/me/wt`，fallback 到 `/Users/me/elsewhere` 后能写 `/Users/me/elsewhere` 下任何
    // 内容）。让用户透明知情决策（如安全敏感请右键归档新建会话），而非黑盒静默扩大。
    // 仅 workspace-write 档需要提示（off 档无 sandbox / strict 档完全只读没扩大风险）。
    deps.emitFallbackMessageThunk(
      sessionId,
      buildCwdFallbackInfoText({
        badCwd: rec.cwd,
        fallbackCwd: effectiveCwd,
        sandboxMode: rec.claudeCodeSandbox,
      }),
    );
    const needSandboxWarn = rec.claudeCodeSandbox === 'workspace-write';
    logger.warn(
      `[sdk-bridge] cwd fallback for ${sessionId}: ${rec.cwd} → ${effectiveCwd}` +
        (needSandboxWarn ? ' (workspace-write sandbox.allowWrite boundary changed)' : ''),
    );
  }

  // REVIEW_60 MED-codex-1 修法(reviewer-codex R1 MED 单方 finding + lead 验证):
  // recovering Map 单飞锁必须在 cwd precheck 之后、任何 await 之前同步 set,
  // 把 archived session unarchive + 占位 message dedup 整段移进 IIFE 让锁覆盖整链。
  // 旧 bug: inflight check L248 与 set L515 之间存在 `await sessionManager.unarchive(L389)`
  // 窗口,两个并发 sendMessage 打到同 archived session 时双方都通过 inflight check → 各自
  // 创建 IIFE → 双 createSession → 破坏「同 session 只允许一条 recovery in-flight」不变量。
  const p = (async (): Promise<string> => {
    try {
      // CHANGELOG_31：用户在 detail 里主动发消息触发 recoverAndSend = 显式表达「我又要聊它了」，
      // 自动取消归档。manager.ts:118-121 立的「归档与 lifecycle 正交，不能因事件流自动 unarchive」
      // 约束针对的是 hook 触发的事件流（避免外部 CLI 在同 cwd 跑导致用户刚归档的会话被自动恢复），
      // 本路径是用户显式 UI 动作不冲突。不 unarchive 的话，jsonl 在 + 不 fork 路径（realId === OLD_ID）
      // 下 OLD_ID record 不动，archived_at 还在 → listHistory 仍返回这条 → 用户体感「我都在跟它聊了
      // 但它还在历史列表里」与 CLAUDE.md「凡让用户感觉像新开会话 / 跳回列表都是 bug」总纲冲突。
      // unarchive 内部 emit session-upserted，HistoryPanel 监听后自动 reload 把这条从历史列表移除。
      //
      // CHANGELOG_99 R1 fix MED-2:本段必须在 cwd precheck **之后** — 确认 cwd 能恢复(原 cwd 在 OR
      // fallback cwd 找到)再 unarchive,避免 cwd fallback 失败 throw 但 session 已被错误 unarchive。
      // REVIEW_60 MED-codex-1 修订:从 IIFE 外移到 IIFE 内,让 single-flight 锁覆盖此 await。
      if (rec.archivedAt !== null) {
        logger.warn(
          `[sdk-bridge] recoverAndSend on archived session ${sessionId}, auto-unarchiving (user explicitly sending message)`,
        );
        await sessionManager.unarchive(sessionId);
      }

      // 占位 message：30s fallback 期间用户至少看到「在恢复」而不是哑巴 busy。
      // 不打 error: true（不是错误，是状态提示）；resume 成功后正常 message 流接续，
      // 占位 message 留在活动流上一行轻量「断开过」痕迹，对回看 / 调试反而有用。
      //
      // REVIEW_17 R3 / M3-R3：5s dedup 窗口防同 sessionId 短时间内反复 recover 重 emit
      // 多条「⚠ SDK 通道已断开」噪声（场景：首次 recover 失败 swallow + 再次 sendMessage
      // 又进 recoverAndSend，inflight 已删，第二条进来无条件 emit，用户在 detail 看到
      // 多条同款占位）。
      // REVIEW_60 MED-codex-1 修订:从 IIFE 外移到 IIFE 内,与 unarchive 同款 single-flight 锁覆盖。
      const lastPlaceholderAt = deps.placeholderEmittedAt.get(sessionId);
      const nowTs = Date.now();
      if (lastPlaceholderAt === undefined || nowTs - lastPlaceholderAt > PLACEHOLDER_DEDUP_MS) {
        deps.placeholderEmittedAt.set(sessionId, nowTs);
        // 顺手清掉过期 entry（避免 Map 无限涨）
        for (const [k, ts] of deps.placeholderEmittedAt) {
          if (nowTs - ts > PLACEHOLDER_DEDUP_MS) deps.placeholderEmittedAt.delete(k);
        }
        deps.ctx.emit({
          sessionId,
          agentId: AGENT_ID,
          kind: 'message',
          payload: { text: '⚠ SDK 通道已断开，正在自动恢复…' },
          ts: nowTs,
          source: 'sdk',
        });
      }

      // **plan restart-controller-jsonl-precheck-20260521 §Step 3f 修法**:
      // jsonl 预检 + fallback 整段 inline 实施 (原 recoverer.ts:378-491 ~113 LOC) 抽到
      // jsonl-fallback.ts helper `maybeJsonlFallback`,与 restart-controller 两条路径共享。
      // helper 内部包办:① prependHistorySummary 续历史摘要 ② createSession with
      // resumeMode='fresh-cli-reuse-app' ③ emit fallback info message (按 §D4 三轴选 builder)
      // ④ emit role='user' message (含 attachments 透传)。详 §D2-C helper 接口设计 + §不变量 11。
      //
      // CHANGELOG_28 / CHANGELOG_99 / CHANGELOG_107 现行 jsonl missing fallback 行为
      // (prependCwd: cwdFellBack ? rec.cwd : effectiveCwd — R2 claude HIGH-F1-2 修法 让
      // cwdFellBack=true 路径保留「原本是哪个 worktree」摘要语义) 由 helper 透传 opts.prependCwd
      // 字段一并迁移。
      //
      // outer cwdFellBack 路径已 emit cwd 切换 fact (line 293-300 不动),helper 内部
      // 进 fallback 分支后会补 emit「成功续上 / 将丢失」详情 (cwdFellBack=true 分支)。
      const fbResult = await maybeJsonlFallback(
        {
          jsonlExistsThunk: deps.jsonlExistsThunk,
          createSession: deps.createThunk, // RecovererCtx 字段名是 createThunk (helper 接口字段名是 createSession,命名对齐 RestartCtx)
          emit: deps.ctx.emit,
          summariseFn: deps.summariseFn,
          listEventsFn: deps.listEventsFn, // Step 3g 新增 ctor 字段(replace recoverer.ts:395 inline closure)
        },
        {
          sessionId,
          cliSessionId: rec.cliSessionId ?? null, // SessionRecord.cliSessionId 是 optional (?: string | null) → ?? null 兜底到 helper opts 的 string | null
          cwd: effectiveCwd, // SDK chdir 目标 (cwdFellBack=true 时是 fallback cwd)
          prependCwd: cwdFellBack ? rec.cwd : effectiveCwd, // R2 claude HIGH-F1-2 修法 (与原 line 392 现行为对齐)
          prompt: text,
          permissionMode: rec.permissionMode ?? undefined,
          claudeCodeSandbox: rec.claudeCodeSandbox ?? undefined,
          model: rec.model ?? undefined,
          extraAllowWrite: rec.extraAllowWrite ?? undefined,
          attachments,
          cwdFellBack,
          emitContext: 'recover',
          // REVIEW_58 HIGH ✅ 收口修法:recoverAndSend 入口已 emit user message,
          // helper 跳过重复 emit 避免双气泡(详 recoverer.recoverAndSend emit user message 段注释)
          skipFirstUserEmit: true,
        },
      );
      if (fbResult.fellBack) {
        // helper 已包办 createSession + 2 emit,不再重复;applicationSid 全程不变 (不变量 3)
        return fbResult.finalSessionId; // == sessionId
      }
      // fellBack=false → fall through 到下面正常 resume 路径 (jsonl 在,行为不变,§不变量 8)

      // plan cross-adapter-parity-20260515 Phase B Step B.1 + REVIEW_41 MED-2 fix:
      // resume 路径下 createThunk 仍可能返回不同 sessionId(CLI 隐式 fork: stream-processor.consume
      // L245 `if (resumeId && resumeId !== realId)` 触发 renameSdkSession + sessions Map rename
      // key)。修前固定 `return sessionId` 等待者拿 OLD,resume implicit fork 时仍撞 not found
      // (修法只覆盖 50% 场景)。修后用 handle.sessionId 反映真实 finalId(不 fork 时 ===
      // sessionId,fork 时 === newRealId)。
      const handle = await deps.createThunk({
        cwd: effectiveCwd, // CHANGELOG_99:正常 resume 路径下 cwd 存在,effectiveCwd === rec.cwd
        prompt: text,
        resume: sessionId,
        // **plan reverse-rename-sid-stability-20260520 §A.4-pre S6.5 R6 HIGH-R6-1 双方共识必修**:
        // recoverer.ts:486 normal resume caller 显式传 resumeCliSid = rec.cliSessionId ?? sessionId,
        // 防 caller 不传时 S6 fork detect condition 短路让 fork detect 完全跳过 (HIGH-R6-1 真问题)。
        // 同 Step C.1 restart-controller 修法 pattern (R3 MED-R3-2 已对)。
        // 反向 rename 后 rec.cliSessionId 是 SDK 当前 thread sid (允许变化),sessionId 是
        // applicationSid (永远稳定);两者不同时显式传 cli sid 让 SDK CLI `--resume` 找正确 jsonl,
        // 同时 S6 effective compare 用 cli sid 才能正确触发 fork detect。
        resumeCliSid: rec.cliSessionId ?? sessionId,
        // permissionMode null = 用户没主动选过，按 createSession 内默认 'default'；
        // 已选过的（acceptEdits / plan / bypassPermissions）必须复原，否则用户体感
        // 「我设过的权限模式被悄悄重置」
        permissionMode: rec.permissionMode ?? undefined,
        // REVIEW_36 HIGH-1 修法：与 fallback 分支同款显式透传（resume 路径 sandbox-resolve
        // 的 fallback #2 sessionRepo 反查 也能拿到，但显式透传 fallback #1 优先级更高 +
        // 与 permissionMode 处理方式对称 + 一致性更好 + 防 sessionRepo 边界 race）。
        claudeCodeSandbox: rec.claudeCodeSandbox ?? undefined,
        // plan model-wiring-and-handoff-20260514 Step 2.4：与 fallback 分支同款显式透传
        // （resume 路径 model-resolve 内部也会 sessionRepo 反查，但显式透传更清晰 + 与
        // claudeCodeSandbox / permissionMode 处理方式对称）。
        model: rec.model ?? undefined,
        // plan cross-adapter-parity-20260515 Phase A Step A.6 / REVIEW_40 R1 MED-F:与 fallback
        // 分支同款显式透传(resume 路径下 sessionRepo 反查也能拿到,但显式透传更清晰 + 与
        // claudeCodeSandbox / model / permissionMode 处理方式对称 + 一致性更好)。
        extraAllowWrite: rec.extraAllowWrite ?? undefined,
        // HIGH-1 修法：attachments 透传，正常 resume 路径下首条恢复消息带图
        attachments,
        // REVIEW_58 HIGH ✅ 收口修法:recoverAndSend 入口已 emit user message,
        // finalizeSessionStart 跳过重复 emit 避免双气泡(详 recoverer.recoverAndSend emit user message 段注释)
        skipFirstUserEmit: true,
      });
      // plan cross-adapter-parity-20260515 Phase B Step B.1 + REVIEW_41 MED-2 fix: 返
      // handle.sessionId 反映真实 finalId(implicit fork 时是 newRealId,正常 resume 时
      // 是 sessionId — 与 fallback path 行为对称)。等待者拿到 finalId 不再撞 fork 后
      // not found。
      return handle.sessionId;
    } finally {
      deps.ctx.recovering.delete(sessionId);
    }
  })();
  deps.ctx.recovering.set(sessionId, p);

  try {
    // plan cross-adapter-parity-20260515 Phase B Step B.1: 返 finalId 给 caller(虽 bridge
    // sendMessage 当前 caller 不消费返回值,但等待者 path 经 inflight 拿同款 finalId)。
    return await p;
  } catch (err) {
    // createSession 失败：占位 message 已经 emit，再补一条 error message 让用户看到原因
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
    throw err;
  }
}
