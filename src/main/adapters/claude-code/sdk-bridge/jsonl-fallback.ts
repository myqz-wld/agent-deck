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

import type { PermissionMode } from '@main/adapters/types';
import type { AgentEvent, UploadedAttachmentRef } from '@shared/types';
import { settingsStore } from '@main/store/settings-store';
import { AGENT_ID } from './constants';
import { prependHistorySummary } from './recoverer-helpers';
import type { JsonlExistsThunk, SummariseFnThunk } from './recoverer';
import {
  buildCwdFallbackSummarySkippedText,
  buildCwdFallbackSummaryUsedText,
  buildJsonlMissingSummarySkippedText,
  buildJsonlMissingSummaryUsedText,
  buildRestartJsonlMissingSummarySkippedText,
  buildRestartJsonlMissingSummaryUsedText,
} from './recoverer-messages';
import type { SdkSessionHandle } from './types';

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
}

export interface JsonlFallbackCtx {
  jsonlExistsThunk: JsonlExistsThunk;
  createSession: (opts: JsonlFallbackCreateOpts) => Promise<SdkSessionHandle>;
  emit: (event: AgentEvent) => void;
  summariseFn: SummariseFnThunk;
  /**
   * events 来源 thunk (test seam) — caller bind `eventRepo.listForSession`;
   * 单测可注入 mock 数组让纯函数行为可控。与 `PrependHistorySummaryOptions.listEventsFn`
   * 字面对齐(mutable `AgentEvent[]`,避免 strictFunctionTypes 透传问题)。
   */
  listEventsFn: (sessionId: string) => AgentEvent[];
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
   * prependHistorySummary 用的 cwd (传给 LLM 摘要 prompt 标注「会话 cwd」)。
   *
   * recover 路径 cwdFellBack=true 时**应**传原 `rec.cwd`(让摘要保留「原本是哪个
   * worktree」的语义); restart 路径 cwdFellBack 永远 false,prependCwd === cwd。
   */
  prependCwd: string;
  /** 用户当前要发的 prompt(原文,不带 prefix);helper 内部走 prependHistorySummary 拼接 */
  prompt: string;
  permissionMode?: PermissionMode;
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict';
  model?: string;
  extraAllowWrite?: readonly string[];
  attachments?: UploadedAttachmentRef[];
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
  const jsonlMissing = opts.cwdFellBack || !ctx.jsonlExistsThunk(opts.cwd, opts.cliSessionId ?? opts.sessionId);

  if (!jsonlMissing) {
    // 正常路径:caller 自走原 resume 路径,helper 不 emit / 不 createSession
    return { finalSessionId: opts.sessionId, fellBack: false };
  }

  // fallback 分支: ① prependHistorySummary 续历史摘要前情
  // (设计动机:让 fresh CLI thread 不失上下文 — 用户体感「Claude 还能续聊」,
  //  避免 CHANGELOG_106 兜底「请下条消息把背景告诉它一次」手动补)。
  // settings 关 / DB 没历史 / 摘要为空 / 超长 / thunk throw → result.used=false 退回 originalText。
  const summaryResult = await prependHistorySummary({
    sessionId: opts.sessionId,
    originalText: opts.prompt,
    cwd: opts.prependCwd,
    autoSummariseOnFallback: settingsStore.get('autoSummariseOnFallback'),
    summariseFn: ctx.summariseFn,
    listEventsFn: ctx.listEventsFn,
  });

  // ② ctx.createSession with resumeMode='fresh-cli-reuse-app'
  //    硬约束 (不变量 10): **不**传 resumeCliSid 字段 — fresh + 非空 resumeCliSid 是
  //    types.ts:121-133 runtime guard reject 非法组合。
  // 抛错 → 直接 rethrow 让 caller catch 块按现行模式 emit error + DB 回滚 + rethrow。
  await ctx.createSession({
    cwd: opts.cwd,
    prompt: summaryResult.prompt, // prepended (含摘要) 或 originalText (失败兜底)
    resume: opts.sessionId, // applicationSid 复用 (不变量 2)
    resumeMode: 'fresh-cli-reuse-app', // 触发 index.ts:419 createSession finalize guard 跳过 finalizeSessionStart
    permissionMode: opts.permissionMode,
    claudeCodeSandbox: opts.claudeCodeSandbox,
    model: opts.model,
    extraAllowWrite: opts.extraAllowWrite,
    attachments: opts.attachments,
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

  // applicationSid 全程不变 (不变量 3) → finalSessionId === opts.sessionId
  return { finalSessionId: opts.sessionId, fellBack: true };
}
