/**
 * codex jsonl-missing fallback helper（REVIEW_60 R4 §D 抽法 #1 mirror claude `jsonl-fallback.ts`
 * / file-size-guardrail.md SOP §档 2 强）。
 *
 * **抽离动机**（cross-adapter parity 维护漂移成本驱动 — reviewer-claude R4 §D 论据）:
 * - 同款 jsonl fallback 逻辑两份独立维护 (codex inline L373-L418 vs claude maybeJsonlFallback) →
 *   修一边 bug 漏修另一边
 * - codex recoverer.ts 把 jsonl-missing fallback inline 在 IIFE 内 ~46 LOC,主路径阅读焦点
 *   从「single-flight recovery 编排」变成「混杂 fallback 实施细节」
 *
 * **形态**（mirror claude `jsonl-fallback.ts maybeJsonlFallback` signature 结构）:
 * - Ctx 注入 jsonlExistsThunk / createSession / emit (test seam)
 * - Opts 传 sessionId / cliSessionId / startedAt / cwd / prompt / 透传字段 (codexSandbox /
 *   model / extraAllowWrite / attachments)
 * - 返 `{fellBack: boolean, finalSessionId: string}` discriminated union (caller 据 fellBack 判
 *   走 fallback 路径还是 fall-through 正常 resume)
 *
 * **codex 与 claude 对称（plan resume-inject-raw-messages-20260601 §D8 解开 REVIEW_60 F5）**:
 * - **历史注入对称**：调 shared `injectResumeHistory`（@main/session/resume-history）拼「总结段 +
 *   最近原始对话消息段 + 当前消息」。3 thunk（summariseFn / listEventsFn / listMessagesFn）+
 *   maxEventIdFn + prependCwd 经 Ctx/Opts 注入（recover-and-send-impl 在 entry emit user 前固化
 *   maxEventIdBefore 排除当前消息）。
 * - **emit text 双分支**（buildCodexJsonlMissingSummaryUsedText / SkippedText，对称 claude
 *   buildJsonlMissingSummaryUsed/SkippedText）：used=true 历史已注入 / used=false 退回纯当前消息。
 * - **original-over-length 阻塞态**（§D6 step0）：originalText > maxLength → throw 给 recoverer
 *   outer catch（不进 createSession，codex create-session-validate.ts 有 MAX throw 会阻塞 fresh thread）。
 *
 * **不变量**:
 * - createSession opts 字段照透传 (resume=sessionId / resumeMode='fresh-cli-reuse-app' /
 *   codexSandbox / model / extraAllowWrite / attachments / skipFirstUserEmit:true)
 * - REVIEW_58 HIGH ✅ 收口 skipFirstUserEmit:true (recoverAndSend 入口已 emit user message)
 *
 * **测试 seam**: Ctx 全部注入,test 可 mock jsonlExistsThunk false → fallback path / mock
 * createSession 验透传字段。`recoverer-jsonl-exists.test.ts` 不受影响 (jsonlExistsThunk 实现仍在
 * recoverer.ts 中定义)。
 */
import type { AgentEvent, UploadedAttachmentRef } from '@shared/types';
import { settingsStore } from '@main/store/settings-store';
import { injectResumeHistory } from '@main/session/resume-history';
import { toCodexModelOverride } from '../sdk-model';
import { AGENT_ID, MAX_MESSAGE_LENGTH } from './constants';
import {
  buildCodexJsonlMissingSummaryUsedText,
  buildCodexJsonlMissingSummarySkippedText,
} from './codex-recoverer-messages';
import type { CreateSessionThunk, JsonlExistsThunk } from './recoverer';
import type {
  SummariseFnThunk,
  ListEventsFnThunk,
  ListRecentMessagesFnThunk,
} from './recoverer/_deps';
import log from '@main/utils/logger';

const logger = log.scope('codex-jsonl-fallback');

export interface CodexJsonlFallbackCtx {
  jsonlExistsThunk: JsonlExistsThunk;
  createSession: CreateSessionThunk;
  emit: (event: AgentEvent) => void;
  /**
   * **plan resume-inject-raw-messages-20260601 §D8**: LLM 总结 thunk(test seam)。caller bind
   * `summariseSessionForHandOff(cwd, events, 'Agent')`(复用 claude oneshot 本地 OAuth)。
   */
  summariseFn: SummariseFnThunk;
  /**
   * **plan resume-inject §D7**: 全量 events 来源 thunk(test seam)，喂 summariseFn 出 4 节结构。
   */
  listEventsFn: ListEventsFnThunk;
  /**
   * **plan resume-inject §D5**: message-only 来源 thunk(test seam)，拼「最近原始对话消息段」。
   */
  listMessagesFn: ListRecentMessagesFnThunk;
}

export interface CodexJsonlFallbackOpts {
  /** applicationSid = caller 入参 sessionId (与 sessions.id 同维) */
  sessionId: string;
  /** sessionRepo.cliSessionId ?? null (反向 rename 后 cli sid 维度;预检走 thread_id) */
  cliSessionId: string | null;
  /** sessionRepo.startedAt (date-based 路径定位 ~/.codex/sessions/<YYYY>/<MM>/<DD>/) */
  startedAt: number;
  /** SDK chdir 目标 (cwdFellBack=true 时是 fallback cwd,否则原 rec.cwd) */
  cwd: string;
  /**
   * **plan resume-inject §D7**: injectResumeHistory 总结 cwd（传 rec.cwd 保留「原本哪个
   * worktree」语义，与 claude prependCwd 对称；codex cwd fallback 时 cwd 是 fallback cwd 但
   * 总结 prompt 标注用原 cwd 更有意义）。
   */
  prependCwd: string;
  /** recoverer 入参 text (本批 sendMessage 用户输入) */
  prompt: string;
  /**
   * **plan resume-inject §D4**: maxEventId thunk（caller 在 entry emit user **前**固化常量后
   * 绑 `() => maxEventIdBefore`，injectResumeHistory 作 beforeIdInclusive 排除当前消息）。
   */
  maxEventIdFn: () => number | null;
  /** rec.codexSandbox ?? undefined (显式透传防静默降默认) */
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
  /** rec.model ?? undefined (Codex runtime v0.131.0+ per-thread override) */
  model?: string;
  /** rec.extraAllowWrite ?? undefined (parity 透传,codex runtime 不消费仅持久化) */
  extraAllowWrite?: readonly string[];
  /**
   * plan codex-recover-network-dirs-parity-20260602：rec.networkAccessEnabled ?? undefined。
   * **codex SDK runtime 真消费**（区别 extraAllowWrite）—— fresh thread 起动时透传让 reviewer-codex
   * 保持网络访问。recover + restart 两路共用本 opts（restart-controller 也调本 helper）。
   */
  networkAccessEnabled?: boolean;
  /**
   * plan codex-recover-network-dirs-parity-20260602：rec.additionalDirectories ?? undefined。
   * codex SDK runtime 真消费 —— fresh thread 起动时透传让 reviewer 保持跨目录读写能力。
   */
  additionalDirectories?: readonly string[];
  /** 首条恢复消息带图 attachments 透传 */
  attachments?: UploadedAttachmentRef[];
  /**
   * **R2 reviewer-codex HIGH + reviewer-claude 反驳轮证实修法（对称 claude jsonl-fallback.ts）**：
   * recover 路径在 `await injectResumeHistory`（summariseFn LLM oneshot 10-30s）期间用户若主动
   * close → closeImpl no-op adapter.closeSession + setLifecycle('closed') 但不 abort 在途 recovering
   * promise。await resolve 后 helper 若继续 createSession 起 fresh thread → 首条 SDK 事件过 ensure
   * （closed && archivedAt===null && source==='sdk'）→ 复活成 active，反转用户显式 close。
   * 修法：recover caller 传本 thunk（`() => sessionRepo.get(sid)?.lifecycle==='closed' || missing`），
   * helper await 后重读 — closed/missing → abort 不起 fresh（返 aborted:true）。单线程无二次 TOCTOU。
   */
  isCancelledFn?: () => boolean;
}

export interface CodexJsonlFallbackResult {
  /** true = jsonl missing 走了 fallback (createSession fresh-cli-reuse-app) / false = jsonl 在 fall through */
  fellBack: boolean;
  /** fallback 路径下 = sessionId (applicationSid 不变);fall through 时不消费 */
  finalSessionId: string;
  /**
   * **R2 HIGH 修法（对称 claude）**：recover 路径 await injectResumeHistory 后重读 lifecycle 发现
   * 已 closed/missing（用户 await 窗口内主动 close）→ abort 不起 fresh thread。caller 必须在判
   * fellBack/fall-through **之前**先检查本字段：true → 直接 return finalSessionId 静默结束
   * （lifecycle 已是用户想要的 closed，不 createSession / 不 emit / 不 fall through，避免复活）。
   */
  aborted?: boolean;
}

/**
 * codex jsonl-missing 预检 + fallback 入口。
 *
 * 预检使用 cliSessionId ?? sessionId 维度 (jsonl 文件命名 `rollout-<TIMESTAMP>-<thread_id>.jsonl`,
 * 反向 rename 后 cli_session_id 与 applicationSid 解耦)。详 codex recoverer.ts L355-L372 节注释。
 *
 * **fellBack=true 路径** (jsonl 不在 / 用户清 / 跨设备同步丢):
 * - console.warn + emit no-summary text
 * - createSession({resume:sessionId, resumeMode:'fresh-cli-reuse-app', ...透传字段})
 * - return {fellBack:true, finalSessionId:sessionId} (applicationSid 不变,反向 rename 不动 sessions.id)
 *
 * **fellBack=false 路径** (jsonl 在):
 * - 直接 return {fellBack:false, finalSessionId:sessionId} caller fall through 到正常 resume 路径
 *
 * **REVIEW_60 R3 reviewer-claude R3 PASS 验证**: emit + createSession 顺序与 inline 字面等价,
 * 行为零变化。
 */
export async function maybeCodexJsonlFallback(
  ctx: CodexJsonlFallbackCtx,
  opts: CodexJsonlFallbackOpts,
): Promise<CodexJsonlFallbackResult> {
  // 预检 jsonl 是否存在 — codex CLI resume 时找不到 jsonl 会失败 (SDK 抛 "Codex Exec exited with ...")
  // 触发条件:jsonl 被用户手动清 / 跨设备同步未带 / codex CLI 自身清理
  if (ctx.jsonlExistsThunk(opts.cliSessionId ?? opts.sessionId, opts.startedAt)) {
    // jsonl 在 → caller fall through 到正常 resume 路径
    return { fellBack: false, finalSessionId: opts.sessionId };
  }

  logger.warn(
    `[codex-bridge] resume jsonl missing for ${opts.sessionId} (startedAt ${new Date(opts.startedAt).toISOString()}), ` +
      `falling back to new thread (CLI history lost but app DB events/file_changes preserved)`,
  );

  // **plan resume-inject-raw-messages-20260601 §D2/§D8 修法（解开 REVIEW_60 F5）**：
  // codex 端原本完全不注入历史（只 emit「请下条消息把背景给 Codex」），本 plan 让 codex 与
  // claude 对称走 injectResumeHistory 拼「总结段 + 最近原始对话消息段 + 当前消息」三段结构化
  // 文本（§架构地基：拼 1 条结构化 user message 是唯一正解）。DB 没历史 / 总结失败 / 预算边界 /
  // thunk throw → used=false 退回 originalText（仍 createSession 起 fresh thread）。
  // **唯一例外** original-over-length（§D6 step0 + §不变量 1）：originalText 自身 > maxLength →
  // throw 让 recoverer outer catch emit error + 不进 createSession（codex create-session-validate.ts
  // 有 MAX throw 会阻塞 fresh thread → 这里提前拦下给清晰错误）。
  const summaryResult = await injectResumeHistory({
    sessionId: opts.sessionId,
    originalText: opts.prompt,
    cwd: opts.prependCwd,
    recentMessagesCount: settingsStore.get('resumeRecentMessagesCount'),
    maxLength: MAX_MESSAGE_LENGTH,
    agentName: 'Agent', // §D8: codex 视角不自称「Claude 会话」
    maxEventIdFn: opts.maxEventIdFn,
    summariseFn: ctx.summariseFn,
    listEventsFn: ctx.listEventsFn,
    listMessagesFn: ctx.listMessagesFn,
  });
  if (summaryResult.failReason === 'original-over-length') {
    throw new Error(
      `单条消息 ${opts.prompt.length.toLocaleString()} 字符超过 ${MAX_MESSAGE_LENGTH.toLocaleString()} 字符上限，无法作为 fallback 首条 prompt。请精简或拆分发送。`,
    );
  }

  // **R2 reviewer-codex HIGH + reviewer-claude 反驳轮证实修法（对称 claude jsonl-fallback.ts）**：
  // await injectResumeHistory（LLM oneshot 10-30s）后、createSession 前重读 lifecycle。recover
  // 路径若用户在 await 窗口内主动 close → isCancelledFn 返 true → abort 不起 fresh thread（否则
  // createSession SDK 事件过 ensure closed→active 复活，静默反转用户显式 close）。lifecycle 已是
  // 用户想要的 closed，abort 时不 createSession / 不 emit / 直接返 aborted:true。单线程无二次 TOCTOU。
  if (opts.isCancelledFn?.()) {
    logger.warn(
      `[codex-bridge] recover fallback aborted: session ${opts.sessionId} closed during summary await (user close)`,
    );
    return { fellBack: false, finalSessionId: opts.sessionId, aborted: true };
  }

  // fallback 路径:不带 resume + 显式透传 sandbox/model/extraAllowWrite 否则静默降全局默认
  // (与 claude REVIEW_36 HIGH-1 同款教训)。attachments 透传让首条恢复消息带图。
  // **plan reverse-rename-sid-stability-20260520 §A.4-pre S8 R3 HIGH-G + R5 HIGH-R5-1 +
  // R6 MED-R6-1 + R7 HIGH-R7-1 修订 (codex 对称 claude recoverer.ts:466)**:
  // jsonl-missing fallback 不再创建新 sessions row,改用 resumeMode='fresh-cli-reuse-app' 显式
  // 语义 + 复用 applicationSid (sessionId);first realId 后通过 sessionManager.updateCliSessionId
  // 走 manager 黑名单链 (R5 HIGH-R5-1 + R6 MED-R6-1 修订)。
  await ctx.createSession({
    cwd: opts.cwd,
    prompt: summaryResult.prompt, // 三段结构化文本 (含历史) 或 originalText (used:false 兜底)
    // **R6 MED-R6-1 修订**: resume = applicationSid (复用 caller 入参 sessionId)
    resume: opts.sessionId,
    // **R3 HIGH-G + R7 HIGH-R7-1 修订**: 显式 mode 字段触发 fresh CLI thread + 复用 applicationSid
    resumeMode: 'fresh-cli-reuse-app',
    codexSandbox: opts.codexSandbox,
    model: toCodexModelOverride(opts.model),
    extraAllowWrite: opts.extraAllowWrite,
    // plan codex-recover-network-dirs-parity-20260602：fresh thread 起动透传 network/dirs
    // （codex SDK runtime 真消费）让 reviewer-codex jsonl-missing fallback 后保持网络 + 跨目录能力。
    networkAccessEnabled: opts.networkAccessEnabled,
    additionalDirectories: opts.additionalDirectories,
    attachments: opts.attachments,
    // REVIEW_58 HIGH ✅ 收口修法:recoverAndSend 入口已 emit user message,
    // createSession resume path 跳过重复 emit (详 recoverer.recoverAndSend emit user message 段注释)
    skipFirstUserEmit: true,
    // **REVIEW_99 R3 cancellation-epoch MED 修法 (对称 claude jsonl-fallback)**:透传 recover caller
    // 的 cancelGuard 让 fresh-thread createSession 内部 pre-registration await 后、sessions.set 前再查
    // 一次 epoch(覆盖 helper isCancelledFn 检查点与 createSession sessions.set 之间的二段 await 窗口)。
    // recover 路径 isCancelledFn = cancelGuard 同一 closure;restart 路径 isCancelledFn undefined → 不 gate。
    cancelCheck: opts.isCancelledFn,
  });

  // **REVIEW_81 MED 修法（reviewer-codex 单方 + lead claude parity 验证）**:
  // fallback info message 必须 emit 在 createSession **成功之后**（与 claude jsonl-fallback.ts:277
  // step ③ 同款顺序）。修前 emit 在 createSession 之前 → createSession reject 时用户先看到
  // 「本会话续聊从 fresh thread 开始 (历史保留)」info，随后又看到 recoverer outer catch 的
  // 「⚠ 自动恢复失败」error → 时间线自相矛盾（fallback 已开始 vs 又失败）。移到 createSession
  // 成功后 emit：createSession throw 时本 emit 不执行，rethrow 给 recoverer outer catch 只 emit
  // 一条 error message，时间线干净（cross-adapter parity 对齐 claude）。
  // **plan resume-inject §D8**: 文案按 summaryResult.used 二态选 builder（对称 claude
  // buildJsonlMissingSummaryUsed/SkippedText）— used=true 历史已注入「应能续上前情」/
  // used=false 退回纯当前消息「请补背景」。
  ctx.emit({
    sessionId: opts.sessionId,
    agentId: AGENT_ID,
    kind: 'message',
    payload: {
      text: summaryResult.used
        ? buildCodexJsonlMissingSummaryUsedText(opts.cwd)
        : buildCodexJsonlMissingSummarySkippedText(opts.cwd),
    },
    ts: Date.now(),
    source: 'sdk',
  });

  // plan cross-adapter-parity-20260515 Phase B Step B.2: 返 sessionId (== applicationSid 不变,
  // 不再调 sessionManager.renameSdkSession — 反向 rename 不动 sessions.id)
  return { fellBack: true, finalSessionId: opts.sessionId };
}
