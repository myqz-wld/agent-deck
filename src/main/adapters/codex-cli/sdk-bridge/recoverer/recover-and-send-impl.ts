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
import { eventRepo } from '@main/store/event-repo';
import { AGENT_ID, MAX_MESSAGE_LENGTH } from '../constants';
import {
  buildCodexCwdMissingErrorText,
  buildCodexCwdFallbackInfoText,
} from '../codex-recoverer-messages';
import { maybeCodexJsonlFallback } from '../codex-jsonl-fallback';
import type {
  CreateSessionThunk,
  CwdExistsThunk,
  FindFallbackCwdThunk,
  JsonlExistsThunk,
  RecovererCtx,
  SendMessageThunk,
  SummariseFnThunk,
  ListEventsFnThunk,
  ListRecentMessagesFnThunk,
} from './_deps';
import { PLACEHOLDER_DEDUP_MS } from './_deps';
import log from '@main/utils/logger';

const logger = log.scope('codex-recoverer');

export interface RecoverAndSendDeps {
  readonly ctx: RecovererCtx;
  readonly placeholderEmittedAt: Map<string, number>;
  readonly createThunk: CreateSessionThunk;
  readonly sendThunk: SendMessageThunk;
  readonly jsonlExistsThunk: JsonlExistsThunk;
  readonly cwdExistsThunk: CwdExistsThunk;
  readonly findFallbackCwd: FindFallbackCwdThunk;
  /**
   * **plan resume-inject-raw-messages-20260601 §D5/§D7/§D8**: 3 thunk 透传给 codex-jsonl-fallback
   * 让其调 injectResumeHistory 拼「总结段 + 原始对话段 + 当前消息」(对称 claude 端)。
   * maxEventIdFn 不在此 — recover-and-send-impl 在 entry emit user **前**直接 eventRepo.maxEventId
   * 捕获常量后构造 `() => maxEventIdBefore` 传给 helper（时机敏感不走 ctor thunk，对称 claude）。
   */
  readonly summariseFn: SummariseFnThunk;
  readonly listEventsFn: ListEventsFnThunk;
  readonly listMessagesFn: ListRecentMessagesFnThunk;
}

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
    let finalId: string;
    try {
      finalId = (await inflight) as string;
    } catch {
      // 第一波恢复已失败,第二条用 OLD 再撞一次触发新一轮 recovery 路径
      finalId = sessionId;
    }
    // attachments 透传（与 claude HIGH-1 修法同款）：第二条等待者带的图属于「自己这条 message」
    // 与第一条独立，必须走完整 sendMessage 路径。
    await deps.sendThunk(finalId, text, attachments);
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

  // **plan resume-inject-raw-messages-20260601 §D4：在 entry emit user message 之前固化
  // maxEventIdBefore**（对称 claude recover-and-send-impl）。下面 emit user message 会落库 →
  // 若 codex-jsonl-fallback 用「emit 后」的 maxEventId 作 beforeIdInclusive 会把当前消息算进
  // 「最近原始对话消息段」→ 与拼接末段重复 + 白占 slot。这里先捕获常量值（emit 前 max id =
  // 最后一条真实历史本身），传给 maybeCodexJsonlFallback.maxEventIdFn 作 `() => maxEventIdBefore`
  // thunk。同步读一次兜底 try/catch 防 eventRepo 抛错穿透阻断 fallback（§不变量 1 永不抛错）。
  let maxEventIdBefore: number | null = null;
  try {
    maxEventIdBefore = eventRepo.maxEventId(sessionId);
  } catch {
    maxEventIdBefore = null;
  }

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

  // CHANGELOG_99 cwd 失效根治（与 claude 同款 R1 fix MED-2 顺序：cwd 校验 → unarchive,
  // 避免 archived session cwd fallback 失败前被 unarchive 成 active 但实际死路一条）。
  //
  // symmetry-plan P3 R2-2 (reviewer-claude MED-G):cwd fallback 后 effectiveCwd 仍可走正常 resume
  // (codex jsonl 独立于 cwd,详 recoverer.ts L38-40 节注释),不再像 claude 那样强制 fresh thread。
  let effectiveCwd = rec.cwd;
  if (!deps.cwdExistsThunk(rec.cwd)) {
    const fallback = deps.findFallbackCwd(rec.cwd);
    if (fallback === null) {
      // 真没救：emit 清晰错误,throw,不进 placeholder 路径。
      // **不 unarchive**（archived 状态下 throw,session 仍归档，用户在 SessionList "已归档"
      // 列表能看到清晰错误信息 — 与 claude MED-2 fix 同款）
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
      // **REVIEW_81 MED 修法**: closed 会话被入口 emit user message 复活成 active，cwd 全 miss
      // 此路径 throw 前不起 createSession（dead-active 幽灵）。wasClosed 时走 markClosed 再关闭
      // （与 archived 路径「cwd-miss 时保持归档」对称 — closed 也应保持 closed）。markClosed 放
      // error message emit 之后：error emit（source:'sdk'）过 ingest 时 record 已 active →
      // ensure 走 manager.ts:261 `return existing` 不再复活 → 顺序安全（与 claude C2 同款结论）。
      if (wasClosed) sessionManager.markClosed(sessionId);
      throw new Error(
        `session ${sessionId} cwd does not exist and no fallback available: ${rec.cwd}`,
      );
    }
    effectiveCwd = fallback;
    // emit cwd fallback info 让用户知情。
    // symmetry-plan P3 R2-2 (reviewer-claude MED-G):text 改正确反映 codex 实际行为 — codex jsonl
    // 在 ~/.codex/sessions/<YYYY>/<MM>/<DD>/ date-based 目录,**完全独立于 cwd**(与 claude
    // ~/.claude/projects/<encoded-cwd>/<sid>.jsonl 不同 — 详 recoverer.ts L38-40 节注释)。
    // 修前 text 错说「jsonl 在原 cwd 下,本会话续聊从 fresh thread 开始」与代码自身注释自相矛盾。
    // 修后 cwd fallback 不再强制 fresh thread(下方 fallback 条件改 `if (!jsonlExistsThunk)`),
    // codex resumeThread + workingDirectory:effectiveCwd 正常进 SDK 保留对话历史。
    // 用户提示重点是「文件引用可能不再指向同一文件」(SDK turn 内引用 cwd 内相对路径会失效)。
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
          payload: { text: '⚠ Codex 通道已断开，正在自动恢复…' },
          ts: nowTs,
          source: 'sdk',
        });
      }

      // CHANGELOG_28 同款：预检 jsonl 是否存在 — codex CLI resume 时找不到 jsonl 会失败，
      // SDK 抛 "Codex Exec exited with ..." 错误，比 try/catch 后字符串匹配 fallback 更可靠。
      //
      // 触发条件：jsonl 被用户手动清 / 跨设备同步未带 / codex CLI 自身清理。预检使用
      // sessionRepo.startedAt 拿 createdAt 日期定位 ~/.codex/sessions/<YYYY>/<MM>/<DD>/ 目录,
      // 扫 *-<threadId>.jsonl 文件。详 `defaultCodexResumeJsonlExists` 算法。
      //
      // symmetry-plan P3 R2-2 (reviewer-claude MED-G):删 `cwdFellBack ||` 强制 fallback。
      // 修前 cwdFellBack 强制 fresh thread 即使 jsonl 在 — 用户无谓失去对话历史。
      // 实际上 codex jsonl 完全独立于 cwd(date-based 路径,详 recoverer.ts L38-40 注释 +
      // emit text),codex resumeThread + workingDirectory:effectiveCwd 让 SDK 在 fallback cwd
      // 下 chdir 但仍拿到原 thread 历史 → 与 claude 行为对称(claude 同款场景下 force fallback
      // 是因为 jsonl 真在 cwd 下,codex 没这个限制)。仅 jsonl 真不在时才走 fresh thread fallback。
      // codex jsonl 文件命名规则:`rollout-<TIMESTAMP>-<thread_id>.jsonl`(见
      // defaultCodexResumeJsonlExists 算法 `endsWith(\`-${threadId}.jsonl\`)`)
      // → 预检参数必须用 thread_id 维度(= sessions.cli_session_id 列值,反向 rename 后
      // 与 applicationSid 解耦)。同文件正常 resume 路径已显式 future-proof
      // 防御 (`rec.cliSessionId ?? sessionId`),本预检入口与之对称。
      // 修前用 `sessionId`(applicationSid 维度) → 反向 rename 后 cliSessionId !== sessionId
      // 时预检永远 miss → falsely trigger fresh thread fallback → 用户失对话历史 + 误导
      // warning。详 ref/reviews/REVIEW_56.md HIGH-1。
      // REVIEW_60 R4 §D 抽法 #1 修法: jsonl-missing fallback 整段抽到 codex-jsonl-fallback.ts
      // helper (mirror claude jsonl-fallback.ts cross-adapter parity 维护单点),详 helper jsdoc。
      // 行为字面等价于原 inline (REVIEW_60 R4 reviewer-claude PASS 验证),仅平移 + 抽接口。
      const fbResult = await maybeCodexJsonlFallback(
        {
          jsonlExistsThunk: deps.jsonlExistsThunk,
          createSession: deps.createThunk,
          emit: deps.ctx.emit,
          // plan resume-inject §D5/§D7/§D8: 3 thunk 让 helper 调 injectResumeHistory 拼三段历史
          summariseFn: deps.summariseFn,
          listEventsFn: deps.listEventsFn,
          listMessagesFn: deps.listMessagesFn,
        },
        {
          sessionId,
          cliSessionId: rec.cliSessionId ?? null,
          startedAt: rec.startedAt,
          cwd: effectiveCwd,
          // plan resume-inject §D7: 总结 cwd 用原 rec.cwd 保留「原本哪个 worktree」语义
          // (对称 claude prependCwd；codex cwd fallback 时 effectiveCwd 是 fallback cwd 但 codex
          //  jsonl 独立 cwd，总结 prompt 标注用原 cwd 更有意义)。
          prependCwd: rec.cwd,
          prompt: text,
          // plan resume-inject §D4: maxEventIdBefore 在 entry emit user 之前固化(见上)，thunk 返
          // 常量排除当前消息(injectResumeHistory 内 try/catch 防御，这里已 null 兜底)。
          maxEventIdFn: () => maxEventIdBefore,
          codexSandbox: rec.codexSandbox ?? undefined,
          model: rec.model ?? undefined,
          extraAllowWrite: rec.extraAllowWrite ?? undefined,
          attachments,
        },
      );
      if (fbResult.fellBack) {
        // helper 已包办 emit + createSession,applicationSid 全程不变 (反向 rename §不变量)
        return fbResult.finalSessionId; // == sessionId
      }
      // fellBack=false → fall through 到下面正常 resume 路径 (jsonl 在,行为不变)

      // 正常 resume 路径：jsonl 在 + cwd 有 → 走 createSession({resume, prompt, codexSandbox, model, attachments})
      // 复用 createSession 内部全套 protocol。
      // plan cross-adapter-parity-20260515 Phase A Step A.7:extraAllowWrite 与 codexSandbox 同样
      // 显式透传(不同于 model 字段:codex-sdk v0.131.0+ 已 runtime 真生效;本字段仍仅持久化未消费)。
      // plan cross-adapter-parity-20260515 Phase B Step B.2 + REVIEW_41 MED-2 fix: 拿 handle
      // 反映真实 finalId(codex spike-A2 实测 resume 不 fork → handle.sessionId === sessionId,
      // 但保 future-proof 防 codex SDK 升级 / 行为变更,且与 claude resume path 对称)。
      const handle = await deps.createThunk({
        cwd: effectiveCwd,
        prompt: text,
        resume: sessionId,
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
        model: rec.model ?? undefined,
        extraAllowWrite: rec.extraAllowWrite ?? undefined,
        attachments,
        // REVIEW_58 HIGH ✅ 收口修法:recoverAndSend 入口已 emit user message,
        // createSession resume path 跳过重复 emit(详 recoverer.recoverAndSend emit user message 段注释)
        skipFirstUserEmit: true,
      });
      // plan cross-adapter-parity-20260515 Phase B Step B.2 + REVIEW_41 MED-2 fix: 与 claude
      // resume path 对称返 handle.sessionId(codex 现实测不 fork 但写法 future-proof)。
      return handle.sessionId;
    } finally {
      deps.ctx.recovering.delete(sessionId);
    }
  })();
  deps.ctx.recovering.set(sessionId, p);

  try {
    // plan cross-adapter-parity-20260515 Phase B Step B.2: 返 finalId 给 caller(虽 bridge
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
    // **REVIEW_81 MED 修法**: closed 会话被入口 emit user message 复活成 active，createSession
    // reject 后无 SDK live session（dead-active 幽灵）。wasClosed 时走 markClosed 再关闭。
    // 顺序：上面 error message emit（source:'sdk'）过 ingest 时 record 已 active → ensure 走
    // manager.ts:261 return existing **不再复活**（仅 closed 才复活）→ 回滚放 error emit 之后安全
    // （markClosed active→closed 一次到位，与 claude C2 反驳轮关键确证同款顺序坑结论）。
    if (wasClosed) sessionManager.markClosed(sessionId);
    throw err;
  }
}
