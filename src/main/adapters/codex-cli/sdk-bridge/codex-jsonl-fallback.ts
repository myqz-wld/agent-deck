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
 * **codex 精简版差异 vs claude**:
 * - **无 LLM 摘要 prepend** (claude 端 maybeJsonlFallback 含 summariseFn + prependHistorySummary
 *   + 6 emit text builder 应对摘要成功 / 失败双分支;codex 暂不接,REVIEW_60 F5 follow-up 独立 plan 收口)
 * - **emit text 单一** (走 codex-recoverer-messages.ts buildCodexJsonlMissingNoSummaryText)
 * - **不带 prependCwd / cwdFellBack 字段** (claude 端用来选 6 builder 之一;codex 无 LLM 摘要无此分流)
 *
 * **不变量**:
 * - 行为字面等价于 codex recoverer.ts 原 inline L373-L418 (仅平移 + 抽接口,不引入新逻辑)
 * - createSession opts 字段完全照 inline 透传 (resume=sessionId / resumeMode='fresh-cli-reuse-app' /
 *   codexSandbox / model / extraAllowWrite / attachments / skipFirstUserEmit:true)
 * - REVIEW_58 HIGH ✅ 收口 skipFirstUserEmit:true (recoverAndSend 入口已 emit user message)
 *
 * **测试 seam**: Ctx 全部注入,test 可 mock jsonlExistsThunk false → fallback path / mock
 * createSession 验透传字段。`recoverer-jsonl-exists.test.ts` 不受影响 (jsonlExistsThunk 实现仍在
 * recoverer.ts 中定义)。
 */
import type { AgentEvent, UploadedAttachmentRef } from '@shared/types';
import { AGENT_ID } from './constants';
import { buildCodexJsonlMissingNoSummaryText } from './codex-recoverer-messages';
import type { CreateSessionThunk, JsonlExistsThunk } from './recoverer';
import log from '@main/utils/logger';

const logger = log.scope('codex-jsonl-fallback');

export interface CodexJsonlFallbackCtx {
  jsonlExistsThunk: JsonlExistsThunk;
  createSession: CreateSessionThunk;
  emit: (event: AgentEvent) => void;
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
  /** recoverer 入参 text (本批 sendMessage 用户输入) */
  prompt: string;
  /** rec.codexSandbox ?? undefined (显式透传防静默降默认) */
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
  /** rec.model ?? undefined (codex-sdk v0.131.0+ per-thread override) */
  model?: string;
  /** rec.extraAllowWrite ?? undefined (parity 透传,codex runtime 不消费仅持久化) */
  extraAllowWrite?: readonly string[];
  /** 首条恢复消息带图 attachments 透传 */
  attachments?: UploadedAttachmentRef[];
}

export interface CodexJsonlFallbackResult {
  /** true = jsonl missing 走了 fallback (createSession fresh-cli-reuse-app) / false = jsonl 在 fall through */
  fellBack: boolean;
  /** fallback 路径下 = sessionId (applicationSid 不变);fall through 时不消费 */
  finalSessionId: string;
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
  ctx.emit({
    sessionId: opts.sessionId,
    agentId: AGENT_ID,
    kind: 'message',
    payload: {
      text: buildCodexJsonlMissingNoSummaryText(),
    },
    ts: Date.now(),
    source: 'sdk',
  });

  // fallback 路径:不带 resume + 显式透传 sandbox/model/extraAllowWrite 否则静默降全局默认
  // (与 claude REVIEW_36 HIGH-1 同款教训)。attachments 透传让首条恢复消息带图。
  // **plan reverse-rename-sid-stability-20260520 §A.4-pre S8 R3 HIGH-G + R5 HIGH-R5-1 +
  // R6 MED-R6-1 + R7 HIGH-R7-1 修订 (codex 对称 claude recoverer.ts:466)**:
  // jsonl-missing fallback 不再创建新 sessions row,改用 resumeMode='fresh-cli-reuse-app' 显式
  // 语义 + 复用 applicationSid (sessionId);first realId 后通过 sessionManager.updateCliSessionId
  // 走 manager 黑名单链 (R5 HIGH-R5-1 + R6 MED-R6-1 修订)。
  await ctx.createSession({
    cwd: opts.cwd,
    prompt: opts.prompt,
    // **R6 MED-R6-1 修订**: resume = applicationSid (复用 caller 入参 sessionId)
    resume: opts.sessionId,
    // **R3 HIGH-G + R7 HIGH-R7-1 修订**: 显式 mode 字段触发 fresh CLI thread + 复用 applicationSid
    resumeMode: 'fresh-cli-reuse-app',
    codexSandbox: opts.codexSandbox,
    model: opts.model,
    extraAllowWrite: opts.extraAllowWrite,
    attachments: opts.attachments,
    // REVIEW_58 HIGH ✅ 收口修法:recoverAndSend 入口已 emit user message,
    // createSession resume path 跳过重复 emit (详 recoverer.recoverAndSend emit user message 段注释)
    skipFirstUserEmit: true,
  });

  // plan cross-adapter-parity-20260515 Phase B Step B.2: 返 sessionId (== applicationSid 不变,
  // 不再调 sessionManager.renameSdkSession — 反向 rename 不动 sessions.id)
  return { fellBack: true, finalSessionId: opts.sessionId };
}
