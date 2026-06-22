/**
 * jsonl-missing fallback helper —— shared between recoverer.recoverAndSend
 * (jsonl 缺失 / cwdFellBack) 与 restart-controller (restartWithPermissionMode /
 * restartWithClaudeCodeSandbox 冷重启 jsonl 缺失) 两条路径。
 *
 * **plan restart-controller-jsonl-precheck-20260521 §D2 选项 C 决策**:
 * 抽 helper 共享 fallback 路径(原 recoverer.ts:378-491 inline 实施 → 移到本 module),
 * 让两条 caller 路径共享:
 * 1. jsonl 预检 (`cliSessionId ?? sessionId` 维度 — §D3 决策)
 * 2. `prependHistorySummary` 续历史摘要前情(避免 fresh CLI thread 失上下文)
 * 3. `createSession` with `resumeMode='fresh-cli-reuse-app'` 起 fresh CLI thread + 复用 applicationSid
 * 4. emit fallback info message (按 emitContext × cwdFellBack × summary used/failed 三轴选 builder)
 * 5. emit role='user' message (含 attachments 透传)
 *
 * **不变量** (plan §不变量):
 * - 行为对称: restart + recoverer 两条 caller 共享同一 helper
 * - jsonl 缺失走 fresh-cli-reuse-app: ctx.createSession opts.resumeMode='fresh-cli-reuse-app'
 *   (触发 index.ts createSession finalize guard 跳过 finalizeSessionStart)
 * - applicationSid 全程不变: finalSessionId === opts.sessionId
 * - fallback 路径不调 finalizeSessionStart (由 createSession 内 Step 3a.5 guard 跳过)
 * - fallback opts 硬约束 omit resumeCliSid (helper 内部 createSession 调用不传该字段)
 *
 * **helper 副作用归属契约** (§不变量 11):
 * - helper emit fallback info message (按 §D4 三轴矩阵 6 文案,createSession 成功后)
 * - helper emit role='user' message (用户首条 prompt 入 events 不丢)
 * - helper **不** emit error message (caller catch 块负责)
 * - fellBack=true 路径 helper 已包办: createSession 先 / emit 后 (R5 双方共识 emit 顺序)
 *
 * **emit 顺序契约** (R5 双方共识修订 — §不变量 11 项 4):
 * 1. 调 ctx.createSession with `resumeMode='fresh-cli-reuse-app'`
 * 2. emit fallback info message (按 §D4 三轴选 builder)
 * 3. emit role='user' message (含 attachments 透传)
 * 4. 返 `{ finalSessionId: opts.sessionId, fellBack: true }`
 *
 * **emit 必须在 createSession 成功后** — 否则 createSession 抛错时 emit fallback info
 * 已发出,caller catch 块再 emit error message → 用户感知时间线错乱(先「fallback 已成功」
 * 后「失败」)。
 *
 * **形态**: module-level pure async function,**不依赖** facade class state —
 * 让单测可以直接 input/output 验证(Step 4 加单测)。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PermissionMode } from '@main/adapters/types';
import type { AgentEvent, UploadedAttachmentRef } from '@shared/types';
import { settingsStore } from '@main/store/settings-store';
import { encodeClaudeProjectDir } from '@main/platform';
import { injectResumeHistory } from '@main/session/resume-history';
import { AGENT_ID, MAX_MESSAGE_LENGTH } from './constants';
import type { JsonlExistsThunk, JsonlMtimeMsThunk, SummariseFnThunk } from './recoverer';
import {
  buildCwdFallbackSummarySkippedText,
  buildCwdFallbackSummaryUsedText,
  buildJsonlMissingSummarySkippedText,
  buildJsonlMissingSummaryUsedText,
  buildRestartJsonlMissingSummarySkippedText,
  buildRestartJsonlMissingSummaryUsedText,
} from './recoverer-messages';
import type { SdkSessionHandle } from './types';
import log from '@main/utils/logger';

const logger = log.scope('claude-jsonl-fallback');

const HEAL_JSONL_MTIME_SKEW_MS = 2_000;

function latestConversationMessageTs(
  opts: { sessionId: string; emitContext: 'recover' | 'restart' },
  listMessagesFn: JsonlFallbackCtx['listMessagesFn'],
): number | null {
  try {
    const messages = listMessagesFn(opts.sessionId, 1);
    const first = messages[0];
    return typeof first?.ts === 'number' ? first.ts : null;
  } catch (err) {
    logger.warn(
      `[jsonl-fallback] 最近对话消息时间读取失败: emitContext=${opts.emitContext} ` +
        `sessionId=${opts.sessionId}; 继续使用 lastEventAt freshness`,
      err,
    );
    return null;
  }
}

/**
 * helper-local create opts 类型 (R5 codex MED-1 修法):
 *
 * 作为 ClaudeCreateOpts / RestartCreateOpts 的最小公共 subset,让 RestartCtx/RecovererCtx
 * 的 createSession thunk 适配统一接口避免「ClaudeCreateOpts 完整字段 vs RestartCreateOpts
 * 子集」类型 mismatch。
 *
 * **硬约束** (不变量 10):
 * - `resumeMode` 字面量 `'fresh-cli-reuse-app'` (仅 fresh fallback 路径用此 helper)
 * - **不**含 `resumeCliSid` 字段 (types.ts:121-133 7 种合法/非法组合表中,fresh + 非空
 *   resumeCliSid 是 runtime guard reject 非法组合)
 */
export interface JsonlFallbackCreateOpts {
  cwd: string;
  prompt: string;
  resume: string; // applicationSid 复用 (fresh-cli-reuse-app 路径必填)
  resumeMode: 'fresh-cli-reuse-app';
  permissionMode?: PermissionMode;
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict';
  model?: string;
  extraAllowWrite?: readonly string[];
  /**
   * **R6 claude HIGH-1 + codex MED-1 双方共识修法**: mutable `UploadedAttachmentRef[]`
   * 与 CreateSessionThunk (recoverer.ts:62) / ClaudeCreateOpts (types.ts:53) 字面对齐,
   * 避免 strictFunctionTypes contravariance 拒(原 R5 写 readonly 撞 TS2322)。
   * helper 内 `[...arr]` spread 转 readonly→mutable 时自然降级无副作用。
   */
  attachments?: UploadedAttachmentRef[];
  /**
   * **REVIEW_99 R3 cancellation-epoch MED 修法**:fresh-cli fallback 路径 createSession 内部也有
   * pre-registration await(loadSdk / buildMcpServersForSession)窗口。helper 把 recover caller 的
   * cancelGuard(= opts.isCancelledFn 同一 closure)透传到本字段,让 fresh-cli createSession 在
   * sessions.set 前再查一次 epoch — 覆盖 helper isCancelledFn 检查点(injectResumeHistory await 后)
   * 与 createSession 内部 sessions.set 之间的二段 await 窗口。restart 路径不传(undefined → 不 gate)。
   */
  cancelCheck?: () => boolean;
}

export interface JsonlFallbackCtx {
  jsonlExistsThunk: JsonlExistsThunk;
  jsonlMtimeMsThunk: JsonlMtimeMsThunk;
  createSession: (opts: JsonlFallbackCreateOpts) => Promise<SdkSessionHandle>;
  emit: (event: AgentEvent) => void;
  summariseFn: SummariseFnThunk;
  /**
   * 全量 events 来源 thunk (test seam) — caller bind `eventRepo.listForSession`;
   * 单测可注入 mock 数组让纯函数行为可控。喂 `injectResumeHistory` 的 summariseFn 出 4 节结构
   * (总结段数据源,plan resume-inject-raw-messages-20260601 §D7 双数据源之一)。
   */
  listEventsFn: (sessionId: string) => AgentEvent[];
  /**
   * message-only 来源 thunk (test seam) — caller bind `eventRepo.listRecentMessages`;
   * 拼「最近原始对话消息段」(plan resume-inject-raw-messages-20260601 §D5 双数据源之二)。
   * 第二参 limit = recentMessagesCount,第三参 beforeIdInclusive 由 `injectResumeHistory` 从
   * maxEventIdFn 拿到后传入(排除 entry emit 的当前消息)。
   */
  listMessagesFn: (
    sessionId: string,
    limit: number,
    beforeIdInclusive?: number,
  ) => (AgentEvent & { id: number })[];
}

/**
 * Discriminated union (R5 codex MED-2 + R5 claude HIGH-1 修法):
 *
 * - `emitContext='restart'` 时 `restartLabel` **必填**字段 (TS 编译期阻拦漏传)
 * - `emitContext='recover'` 时 `restartLabel` **不允许** (`?: never`),`cwdFellBack` 可选 boolean
 *
 * 让 TS 编译期阻拦 Step 3d/3e snippet 漏传 restartLabel,同时消除 helper code snippet
 * `opts.restartLabel!` non-null assertion 隐藏的 runtime 错乱。
 */
type JsonlFallbackOptsBase = {
  /** caller 应用 sid (= applicationSid 维度,fresh fallback 后保持不变) */
  sessionId: string;
  /**
   * caller cli sid (= sessions.cli_session_id 列值)。可 null(spawn tempKey 阶段 /
   * fresh-cli-reuse-app 期间 cliSessionId 暂时 null)。
   *
   * helper 内部用 `cliSessionId ?? sessionId` 找 jsonl(§D3 决策:CLI jsonl 文件路径
   * 用 cli sid 命名 `~/.claude/projects/<encoded-cwd>/<cliSessionId>.jsonl`)。
   */
  cliSessionId: string | null;
  /** SDK 子进程 chdir 目标 cwd (recover 路径下 cwdFellBack=true 时是 fallback cwd) */
  cwd: string;
  /**
   * injectResumeHistory 用的 cwd (传给 LLM 总结 prompt 标注「会话 cwd」)。
   *
   * recover 路径 cwdFellBack=true 时**应**传原 `rec.cwd`(让总结保留「原本是哪个
   * worktree」的语义); restart 路径 cwdFellBack 永远 false,prependCwd === cwd。
   */
  prependCwd: string;
  /** 用户当前要发的 prompt(原文,不带 prefix);helper 内部走 injectResumeHistory 拼三段 */
  prompt: string;
  /**
   * **plan resume-inject-raw-messages-20260601 §D4：maxEventId thunk（不是预算值）**。
   * 传给 `injectResumeHistory` 作 message-only 查询的 beforeIdInclusive 来源，排除「当前消息」。
   *
   * - **recover 路径**：caller 在 entry emit user message **之前**捕获 `eventRepo.maxEventId(sid)`
   *   常量值后绑成 `() => <captured>` thunk（emit 后再 lazy 调会把当前消息算进去 → off-by-one）。
   * - **restart 路径**：handoffPrompt 不在入口 emit 落库 → 无「当前消息」需排除 → 传 `() => null`。
   *
   * helper(injectResumeHistory) 内 try/catch 调本 thunk（§不变量 1 永不抛错；throw → 退化为
   * 「查最近 N」不加边界，仍继续 fallback）。
   */
  maxEventIdFn: () => number | null;
  /**
   * read-side 幻影 fork 自愈的 freshness 下界，通常传 SessionRecord.lastEventAt。
   *
   * applicationSid.jsonl 必须存在且 mtime 不明显早于本值，才允许替代缺失的 cliSessionId.jsonl。
   * 证据不足时走 fresh fallback，避免真实 fork 的旧 applicationSid.jsonl 被误当成当前历史。
   */
  minHealJsonlMtimeMs: number;
  permissionMode?: PermissionMode;
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict';
  model?: string;
  extraAllowWrite?: readonly string[];
  attachments?: UploadedAttachmentRef[];
  /**
   * REVIEW_58 HIGH ✅ (deep-review 双方共识真问题修法):跳过 helper 内 emit 首条 user
   * message — 让 caller 收口 emit 责任避免双气泡。
   *
   * **触发场景**:recoverer.recoverAndSend 入口已 emit user message(与 live 主路径
   * `sdk-bridge/index.ts:520-535` 时机对称),调 maybeJsonlFallback 时显式传 true 让 helper
   * 跳过重复 emit。详 sdk-bridge/index.ts createSession opts.skipFirstUserEmit jsdoc。
   *
   * **不影响 fallback info message emit**(emit 顺序契约 §3 仍 emit 详 helper jsdoc) —
   * 仅控制 §4 emit role='user' message 这一动作。
   */
  skipFirstUserEmit?: boolean;
  /**
   * **R2 reviewer-codex HIGH + reviewer-claude 反驳轮证实（双方共识，lead 全链 trace + 两端
   * 独立时序脚本复现）**：recover 路径在 `await injectResumeHistory`（summariseFn LLM oneshot
   * 10-30s）期间，用户若在 UI 主动 close → closeImpl 调 adapter.closeSession（此刻 fresh CLI
   * 还没起，sessions Map 无 live internal → early-return no-op）+ setLifecycle('closed')，但
   * **不 abort 在途 recovering promise / 不加黑名单**。await resolve 后 helper 若继续 createSession
   * 起 fresh CLI → 首条 SDK 事件过 ensure（closed && archivedAt===null && source==='sdk'）→
   * **复活成 active**，用户显式 close 被静默反转 + 起一个用户不想要的 fresh CLI（按次计费）。
   *
   * 修法：recover 路径传本 thunk（`() => sessionRepo.get(sid)?.lifecycle === 'closed' || row missing`），
   * helper 在 await **之后**、createSession **之前**重读 — 已 closed/missing → abort 不起 fresh
   * （返 aborted:true），lifecycle 已是用户想要的 closed 无需额外回滚。重读到 createSession 之间
   * 同步无 await，JS 单线程下 close 插不进来（无二次 TOCTOU）。
   *
   * **restart 路径不传本 thunk**（undefined → 不 gate）：restart 本就「先 close 再 cold restart」，
   * 过渡态 closed 是预期，不能用「closed 则 abort」拦它。
   */
  isCancelledFn?: () => boolean;
};

export type JsonlFallbackOpts =
  | (JsonlFallbackOptsBase & {
      emitContext: 'recover';
      /** recover 路径独有: cwd 失效启发式 fallback 触发标记 */
      cwdFellBack?: boolean;
      /** 编译期阻拦 — recover 路径不允许传 restartLabel */
      restartLabel?: never;
    })
  | (JsonlFallbackOptsBase & {
      emitContext: 'restart';
      /** restart 路径不切 cwd,cwdFellBack 永远 false (字段保留对实施 snippet 一致) */
      cwdFellBack?: false;
      /**
       * restart 路径**必填** — `权限模式 ${mode}` (restartWithPermissionMode 路径) /
       * `OS 沙盒 ${sandbox}` (restartWithClaudeCodeSandbox 路径)。
       * 给 `buildRestartJsonlMissingSummary[Used|Skipped]Text(label, cwd)` 用作 label 参数。
       */
      restartLabel: string;
    });

export interface JsonlFallbackResult {
  /**
   * fresh fallback 时 === opts.sessionId (applicationSid 全程不变,不变量 3);
   * fellBack=false 时 === opts.sessionId (caller 自己走原 resume 路径,本字段仅占位)。
   */
  finalSessionId: string;
  /**
   * true → helper 已包办 createSession + 2 次 emit,caller **不再重复** emit / createSession;
   * false → caller 自己走原 resume 路径(restart-controller 走 line 182-198 / 331-346;
   *         recoverer 走 line 500-535 原 resume createSession 路径)。
   */
  fellBack: boolean;
  /**
   * **R2 HIGH 修法**：recover 路径在 await injectResumeHistory 后重读 lifecycle 发现已 closed/missing
   * （用户 await 窗口内主动 close）→ abort 不起 fresh CLI。caller 必须在判 fellBack/fall-through
   * **之前**先检查本字段：true → 直接 return finalSessionId 静默结束（lifecycle 已是用户想要的
   * closed，不 createSession / 不 emit / 不 fall through 到正常 resume，避免复活）。
   * undefined/false → 正常按 fellBack 处理。restart 路径不传 isCancelledFn → 本字段恒 undefined。
   */
  aborted?: boolean;
  /**
   * **CHANGELOG_224 幻影 fork 自愈**: `fellBack=false` 且 helper 检测到「cli sid 维度 jsonl 缺失但
   * applicationSid jsonl 在盘」(CLI `--resume` 下 init 帧吐幻影运行 id,transcript 仍在 applicationSid
   * 名下) → 本字段 = applicationSid(= opts.sessionId)。caller 正常 resume 路径必须把 `resumeCliSid`
   * 切到本值(而非 rec.cliSessionId 那个幻影 id),否则 CLI `--resume <幻影>` hard-fail。
   * undefined → 无幻影,caller 沿用 rec.cliSessionId 原值。fellBack=true / aborted 路径恒 undefined。
   */
  healedCliSessionId?: string;
}

/**
 * jsonl 预检 + (缺失时) fresh CLI fallback 主入口。
 *
 * 行为分两路:
 *
 * - **fallback 路径** (jsonlExistsThunk → false **或** `opts.cwdFellBack === true` 短路):
 *   ① prependHistorySummary 续历史摘要前情 ② ctx.createSession with
 *   `resumeMode='fresh-cli-reuse-app'` ③ emit fallback info message (按 §D4 三轴选 builder)
 *   ④ emit role='user' message (含 attachments 透传)
 *   → 返 `{ finalSessionId: opts.sessionId, fellBack: true }`
 *
 * - **正常路径** (jsonl 存在 + 非 cwdFellBack):
 *   不调 createSession / 不 emit / 不 prependHistorySummary,
 *   → 返 `{ finalSessionId: opts.sessionId, fellBack: false }`
 *   caller 自己走原 resume 路径。
 *
 * **OR 短路顺序铁证**(plan §D5 T10 sub-case + §不变量 10 fail-safe):
 * `cwdFellBack || !jsonlExistsThunk(...)` 短路求值 — cwdFellBack=true 时**不调** jsonlExistsThunk
 * (让 fail-safe 不被绕过)。jsonlExistsThunk 异常 fail-safe 返 true 退化为正常 resume 路径
 * (与 defaultResumeJsonlExists 一致 — recoverer.ts:662-671)。
 *
 * **createSession 抛错时** → helper 直接 rethrow 不 emit;caller catch 块按现行模式
 * emit error message + DB 回滚 + rethrow (recoverer.ts:546-559 / restart-controller.ts:206-225 /
 * 351-369)。
 */
export async function maybeJsonlFallback(
  ctx: JsonlFallbackCtx,
  opts: JsonlFallbackOpts,
): Promise<JsonlFallbackResult> {
  // §D3 决策: jsonl 文件路径用 cli sid 命名,预检需用 cli sid 维度
  // (反向 rename 后 cliSessionId 是 SDK 当前 thread sid,与 jsonl 文件名对应;
  //  sessionId/applicationSid 与 jsonl 文件名解耦)。?? sessionId 兜底防 null 边角。
  // OR 短路: cwdFellBack=true 时不调 jsonlExistsThunk(plan §D5 T10a + §不变量 10 fail-safe)
  let jsonlMissing = opts.cwdFellBack || !ctx.jsonlExistsThunk(opts.cwd, opts.cliSessionId ?? opts.sessionId);

  // **幻影 fork 自愈 (CHANGELOG_224)**: cli sid 维度的 jsonl 缺失,但这极可能是「幻影 fork」——
  // CLI 在 `--resume <applicationSid>` + streaming-input 下,init 帧会吐一个全新「运行 id」
  // (hook/settings-env 按它建空 session-env 目录),而 transcript 实际仍续写在 applicationSid
  // 名下的 jsonl(每条记录 sessionId=applicationSid,parentUuid 直接挂回原消息树)。stream-processor
  // S6 fork detect 只读 init 帧那个运行 id 就写进 cli_session_id 列 → 列指向一个从不落盘的 id。
  // 退 fresh-cli(丢连续会话线退化成 DB 摘要注入,违反 CLAUDE.md「resume 优先」纲领)之前,先探测
  // applicationSid.jsonl: 命中且 mtime 足够新才认为真历史就在盘上,改用它 resume(caller
  // resumeCliSid 跟随 healedCliSessionId),不退 fresh-cli。
  // 触发条件: ① cli sid 维度缺失 ② 非 cwdFellBack(cwd 已切,原 jsonl 不在新 cwd 下,保持 fail-safe
  // fallback 不误判存在) ③ cliSessionId 非空且 != applicationSid(相等时 primary 已覆盖,无幻影)。
  // 本 helper 不主动写 cli_session_id: 它只在 read-side 兜底历史已污染的 row。source-side
  // 修复在 stream-processor 首帧处理处完成，避免后续 resume 再把幻影运行 id 写进 DB。
  let healedCliSessionId: string | undefined;
  if (jsonlMissing && !opts.cwdFellBack && opts.cliSessionId && opts.cliSessionId !== opts.sessionId) {
    if (ctx.jsonlExistsThunk(opts.cwd, opts.sessionId)) {
      const appSidJsonlMtimeMs = ctx.jsonlMtimeMsThunk(opts.cwd, opts.sessionId);
      const freshnessCutoff = opts.minHealJsonlMtimeMs - HEAL_JSONL_MTIME_SKEW_MS;
      const restartMessageTs =
        appSidJsonlMtimeMs != null && opts.emitContext === 'restart'
          ? latestConversationMessageTs(opts, ctx.listMessagesFn)
          : null;
      const restartMessageFreshnessCutoff =
        restartMessageTs == null ? null : restartMessageTs - HEAL_JSONL_MTIME_SKEW_MS;
      const freshEnoughForRestartMessages =
        restartMessageFreshnessCutoff != null &&
        appSidJsonlMtimeMs != null &&
        appSidJsonlMtimeMs >= restartMessageFreshnessCutoff;
      const appSidJsonlIsStale =
        appSidJsonlMtimeMs == null ||
        (appSidJsonlMtimeMs < freshnessCutoff && !freshEnoughForRestartMessages);
      if (appSidJsonlIsStale) {
        logger.warn(
          `[jsonl-fallback] 幻影 fork 自愈跳过: emitContext=${opts.emitContext} ` +
            `cliSessionId=${opts.cliSessionId} 无 jsonl,applicationSid=${opts.sessionId} jsonl 在盘 ` +
            `但 mtime=${appSidJsonlMtimeMs ?? 'null'} 早于 freshnessCutoff=${freshnessCutoff} ` +
            `minHealJsonlMtimeMs=${opts.minHealJsonlMtimeMs}` +
            (restartMessageFreshnessCutoff == null
              ? ''
              : ` restartMessageFreshnessCutoff=${restartMessageFreshnessCutoff}`) +
            `; 走 fresh-cli fallback`,
        );
      } else {
        healedCliSessionId = opts.sessionId;
        jsonlMissing = false;
        logger.warn(
          `[jsonl-fallback] 幻影 fork 自愈: emitContext=${opts.emitContext} ` +
            `cliSessionId=${opts.cliSessionId} 无 jsonl,但 applicationSid=${opts.sessionId} jsonl 在盘 → ` +
            `mtime=${appSidJsonlMtimeMs} freshnessCutoff=${freshnessCutoff}; ` +
            (freshEnoughForRestartMessages
              ? `restartMessageFreshnessCutoff=${restartMessageFreshnessCutoff}; `
              : '') +
            `改用 applicationSid resume (caller resumeCliSid 切到 healedCliSessionId),不退 fresh-cli`,
        );
      }
    }
  }

  if (!jsonlMissing) {
    // 正常路径 / 幻影 fork 自愈命中:caller 自走原 resume 路径,helper 不 emit / 不 createSession。
    // healedCliSessionId 命中时 caller 把 resumeCliSid 切到它(= applicationSid)让 CLI `--resume`
    // 找对 jsonl;未命中(undefined)时 caller 沿用 rec.cliSessionId 原值(行为不变)。
    return { finalSessionId: opts.sessionId, fellBack: false, healedCliSessionId };
  }

  // **CHANGELOG_223 排查日志（fork 子 jsonl 落盘 vs 连续快速重启时序竞态）**：precheck 判定 jsonl
  // 缺失 → 即将走 fresh-cli fallback。落一行 warn 含完整可复现信息：算出的 jsonl 绝对路径让用户能直接
  // `ls` 验证「文件真不在 / 只是 precheck 算错」。restart 路径 cwdFellBack 恒 false → jsonlExistsThunk
  // 真被调用过，path miss 是真 file-existence miss（最值得排查）；recover 路径 cwdFellBack=true 时是
  // cwd 切换的预期 fallback（短路没调 thunk，path 仅为「本该查的位置」参考）。
  const lookupId = opts.cliSessionId ?? opts.sessionId;
  let jsonlPath = '(path compute failed)';
  try {
    jsonlPath = join(homedir(), '.claude', 'projects', encodeClaudeProjectDir(opts.cwd), `${lookupId}.jsonl`);
  } catch {
    // encodeClaudeProjectDir 抛错（非法 cwd）→ 保留占位串，不阻断 fallback
  }
  logger.warn(
    `[jsonl-fallback] precheck MISS → fresh-cli fallback: emitContext=${opts.emitContext} ` +
      `cwdFellBack=${opts.cwdFellBack ?? false} sessionId=${opts.sessionId} ` +
      `cliSessionId=${opts.cliSessionId ?? 'null'} lookupId=${lookupId} cwd=${opts.cwd} jsonlPath=${jsonlPath}`,
  );

  // fallback 分支: ① injectResumeHistory 拼「总结段 + 最近原始对话消息段 + 当前消息」三段
  // (plan resume-inject-raw-messages-20260601 §架构地基：拼 1 条结构化 user message 是唯一正解；
  //  设计动机:让 fresh CLI thread 不失上下文 — 用户体感「Claude 还能续聊」)。
  // DB 没历史 / 总结失败 / 预算边界 / thunk throw → result.used=false 退回 originalText（仍 createSession）。
  // **唯一例外** original-over-length（§D6 step0 + §不变量 1）：originalText 自身 > maxLength →
  // throw 让 caller catch 块按现行模式 emit error + 不进 createSession（超长 prompt 裸进 SDK 会
  // 无界透传撑爆；覆盖 restart 传 handoffPrompt 含 plan 无 cap 的 caller）。
  const summaryResult = await injectResumeHistory({
    sessionId: opts.sessionId,
    originalText: opts.prompt,
    cwd: opts.prependCwd,
    recentMessagesCount: settingsStore.get('resumeRecentMessagesCount'),
    maxLength: MAX_MESSAGE_LENGTH,
    agentName: 'Claude',
    maxEventIdFn: opts.maxEventIdFn,
    summariseFn: ctx.summariseFn,
    listEventsFn: ctx.listEventsFn,
    listMessagesFn: ctx.listMessagesFn,
  });
  if (summaryResult.failReason === 'original-over-length') {
    // §不变量 1 唯一阻塞态：不进 createSession，throw 给 caller catch（emit error + rethrow）。
    throw new Error(
      `单条消息 ${opts.prompt.length.toLocaleString()} 字符超过 ${MAX_MESSAGE_LENGTH.toLocaleString()} 字符上限，无法作为 fallback 首条 prompt。请精简或拆分发送。`,
    );
  }

  // **R2 reviewer-codex HIGH + reviewer-claude 反驳轮证实修法**：await injectResumeHistory（LLM
  // oneshot 10-30s）后、createSession 前重读 lifecycle。recover 路径若用户在 await 窗口内主动
  // close → isCancelledFn 返 true → abort 不起 fresh CLI（否则 createSession SDK 事件过 ensure
  // closed→active 复活，静默反转用户显式 close + 起多余 fresh CLI）。lifecycle 已是用户想要的
  // closed，abort 时不 createSession / 不 emit / 直接返 aborted:true 让 caller 静默结束。
  // 重读到 createSession 之间同步无 await，JS 单线程下 close 插不进来（无二次 TOCTOU）。
  // restart 路径不传 isCancelledFn（undefined）→ 不 gate（restart 本就先 close 再 cold restart）。
  if (opts.isCancelledFn?.()) {
    logger.warn(
      `[sdk-bridge] recover fallback aborted: session ${opts.sessionId} closed during summary await (user close)`,
    );
    return { finalSessionId: opts.sessionId, fellBack: false, aborted: true };
  }

  // ② ctx.createSession with resumeMode='fresh-cli-reuse-app'
  //    硬约束 (不变量 10): **不**传 resumeCliSid 字段 — fresh + 非空 resumeCliSid 是
  //    types.ts:121-133 runtime guard reject 非法组合。
  // 抛错 → 直接 rethrow 让 caller catch 块按现行模式 emit error + DB 回滚 + rethrow。
  await ctx.createSession({
    cwd: opts.cwd,
    prompt: summaryResult.prompt, // 三段结构化文本 (含历史) 或 originalText (used:false 兜底)
    resume: opts.sessionId, // applicationSid 复用 (不变量 2)
    resumeMode: 'fresh-cli-reuse-app', // 触发 index.ts:419 createSession finalize guard 跳过 finalizeSessionStart
    permissionMode: opts.permissionMode,
    claudeCodeSandbox: opts.claudeCodeSandbox,
    model: opts.model,
    extraAllowWrite: opts.extraAllowWrite,
    attachments: opts.attachments,
    // **REVIEW_99 R3 cancellation-epoch MED 修法**:透传 recover caller 的 cancelGuard 让 fresh-cli
    // createSession 内部 pre-registration await 后、sessions.set 前再查一次 epoch(覆盖 helper
    // isCancelledFn 检查点与 createSession sessions.set 之间的二段 await 窗口)。recover 路径 isCancelledFn
    // = cancelGuard 同一 closure;restart 路径 isCancelledFn undefined → cancelCheck 也 undefined 不 gate。
    cancelCheck: opts.isCancelledFn,
    // ⚠️ 严禁传 resumeCliSid (不变量 10)
  });

  // ③ emit fallback info message — 按 emitContext × cwdFellBack × summary used/failed 三轴选 builder
  //    (§D4 文案矩阵 6 case;detail jsdoc 见 recoverer-messages.ts 每个 builder)
  let fallbackMessage: string;
  if (opts.emitContext === 'recover') {
    if (opts.cwdFellBack) {
      // recover 路径 cwdFellBack=true: outer caller (recoverer) 已 emit cwd 切换 fact,
      // 本分支补 emit「成功续上 / 将丢失」详情(不重复 cwd 信息)
      fallbackMessage = summaryResult.used
        ? buildCwdFallbackSummaryUsedText()
        : buildCwdFallbackSummarySkippedText();
    } else {
      fallbackMessage = summaryResult.used
        ? buildJsonlMissingSummaryUsedText(opts.cwd)
        : buildJsonlMissingSummarySkippedText(opts.cwd);
    }
  } else {
    // emitContext === 'restart' — discriminated union 已 narrow opts.restartLabel: string (必填)
    fallbackMessage = summaryResult.used
      ? buildRestartJsonlMissingSummaryUsedText(opts.restartLabel, opts.cwd)
      : buildRestartJsonlMissingSummarySkippedText(opts.restartLabel, opts.cwd);
  }
  ctx.emit({
    sessionId: opts.sessionId,
    agentId: AGENT_ID,
    kind: 'message',
    payload: { text: fallbackMessage }, // 非 error fallback info (区分 caller catch 块的 error message)
    ts: Date.now(),
    source: 'sdk',
  });

  // ④ emit role='user' message — 让用户首条 prompt 入 events 不丢
  //   (fresh fallback 路径 createSession 内 Step 3a.5 finalize guard 跳过整个 finalizeSessionStart →
  //    session-finalize.ts:145-155 现行 emit role='user' 这一动作需由 helper 在此处补回;
  //    字段对齐 index.ts:477-488 sendMessage live session 分支 emit 含 attachments 透传 5 字段 payload)
  // REVIEW_58 HIGH ✅ 收口修法:caller 显式 skipFirstUserEmit=true 时跳过
  // (recoverer.recoverAndSend 入口已 emit,避免双气泡;详 opts.skipFirstUserEmit jsdoc)
  if (!opts.skipFirstUserEmit) {
    ctx.emit({
      sessionId: opts.sessionId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: {
        text: opts.prompt, // 用户原 prompt (不是 prepend 后 summary prompt — UI 显示用户实际发的那条)
        role: 'user',
        ...(opts.attachments && opts.attachments.length > 0 ? { attachments: opts.attachments } : {}),
      },
      ts: Date.now(),
      source: 'sdk',
    });
  }

  // applicationSid 全程不变 (不变量 3) → finalSessionId === opts.sessionId
  return { finalSessionId: opts.sessionId, fellBack: true };
}
