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
 * Missing history is rebuilt by the shared immutable-spool continuation engine. The provider gets
 * the full trusted context, while Agent Deck keeps the already-emitted authoritative user message.
 * Instruction-only quality uses the explicit degraded-copy branch; all richer quality levels use
 * the history-restored branch.
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
import type { CodexThinkingLevel } from '@shared/session-metadata';
import { toCodexModelOverride } from '../sdk-model';
import { AGENT_ID } from './constants';
import {
  buildCodexJsonlMissingContextRestoredText,
  buildCodexJsonlMissingInstructionOnlyText,
} from './codex-recoverer-messages';
import type { CreateSessionThunk, JsonlExistsThunk } from './recoverer';
import type { PrepareRecoveryContinuationThunk } from './recoverer/_deps';
import type { CapturedRecoveryContinuation } from '@main/session/continuation-context/recovery';
import type { AgentEnqueueOptions } from '@main/adapters/types';
import log from '@main/utils/logger';

const logger = log.scope('codex-jsonl-fallback');

export interface CodexJsonlFallbackCtx {
  jsonlExistsThunk: JsonlExistsThunk;
  createSession: CreateSessionThunk;
  emit: (event: AgentEvent) => void;
  prepareRecovery: PrepareRecoveryContinuationThunk;
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
  /** Immutable source captured before the current user event. Null only when capture itself failed. */
  capture: CapturedRecoveryContinuation | null;
  captureError?: unknown;
  /** rec.codexSandbox ?? undefined (显式透传防静默降默认) */
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
  /** rec.model ?? undefined (Codex runtime v0.131.0+ per-thread override) */
  model?: string;
  /** rec.thinking when it is a valid Codex reasoning level. */
  modelReasoningEffort?: CodexThinkingLevel;
  /** rec.extraAllowWrite ?? undefined (parity 透传,codex runtime 不消费仅持久化) */
  extraAllowWrite?: readonly string[];
  /**
   * plan codex-recover-network-dirs-parity-20260602：rec.networkAccessEnabled ?? undefined。
   * **codex SDK runtime 真消费**（区别 extraAllowWrite）—— fresh thread 起动时透传让 reviewer-codex
   * 保持网络访问。
   */
  networkAccessEnabled?: boolean;
  /**
   * plan codex-recover-network-dirs-parity-20260602：rec.additionalDirectories ?? undefined。
   * codex SDK runtime 真消费 —— fresh thread 起动时透传让 reviewer 保持跨目录读写能力。
   */
  additionalDirectories?: readonly string[];
  /** 首条恢复消息带图 attachments 透传 */
  attachments?: UploadedAttachmentRef[];
  initialEnqueueOptions?: AgentEnqueueOptions;
  /**
   * **R2 reviewer-codex HIGH + reviewer-claude 反驳轮证实修法（对称 claude jsonl-fallback.ts）**：
   * recover 路径在 continuation preparation await 期间用户若主动
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
   * **R2 HIGH 修法（对称 claude）**：recover 路径 await preparation 后重读 lifecycle 发现
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

  if (!opts.capture) {
    if (opts.captureError instanceof Error) throw opts.captureError;
    throw new Error('无法捕获不可变的恢复上下文，已停止创建新的 Codex thread。');
  }

  // The capture was completed synchronously before the current user event. Preparation reads only
  // that immutable TEMP spool, so the current event cannot be duplicated in the retained raw tail.
  const recovery = await ctx.prepareRecovery(opts.capture, opts.prompt);

  // **R2 reviewer-codex HIGH + reviewer-claude 反驳轮证实修法（对称 claude jsonl-fallback.ts）**：
  // await continuation preparation 后、createSession 前重读 lifecycle。recover
  // 路径若用户在 await 窗口内主动 close → isCancelledFn 返 true → abort 不起 fresh thread（否则
  // createSession SDK 事件过 ensure closed→active 复活，静默反转用户显式 close）。lifecycle 已是
  // 用户想要的 closed，abort 时不 createSession / 不 emit / 直接返 aborted:true。单线程无二次 TOCTOU。
  if (opts.isCancelledFn?.()) {
    logger.warn(
      `[codex-bridge] recover fallback aborted: session ${opts.sessionId} closed during continuation preparation (user close)`,
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
    trustedContinuation: recovery.turn,
    // **R6 MED-R6-1 修订**: resume = applicationSid (复用 caller 入参 sessionId)
    resume: opts.sessionId,
    // **R3 HIGH-G + R7 HIGH-R7-1 修订**: 显式 mode 字段触发 fresh CLI thread + 复用 applicationSid
    resumeMode: 'fresh-cli-reuse-app',
    codexSandbox: opts.codexSandbox,
    model: toCodexModelOverride(opts.model),
    modelReasoningEffort: opts.modelReasoningEffort,
    extraAllowWrite: opts.extraAllowWrite,
    // plan codex-recover-network-dirs-parity-20260602：fresh thread 起动透传 network/dirs
    // （codex SDK runtime 真消费）让 reviewer-codex jsonl-missing fallback 后保持网络 + 跨目录能力。
    networkAccessEnabled: opts.networkAccessEnabled,
    additionalDirectories: opts.additionalDirectories,
    attachments: opts.attachments,
    initialEnqueueOptions: opts.initialEnqueueOptions,
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
  // Instruction-only is the final explicit degradation level; every richer quality has either a
  // validated checkpoint or retained raw user history and can use the "history restored" copy.
  ctx.emit({
    sessionId: opts.sessionId,
    agentId: AGENT_ID,
    kind: 'message',
    payload: {
      text:
        recovery.prepared.quality === 'instruction-only'
          ? buildCodexJsonlMissingInstructionOnlyText(opts.cwd)
          : buildCodexJsonlMissingContextRestoredText(opts.cwd),
    },
    ts: Date.now(),
    source: 'sdk',
  });

  // plan cross-adapter-parity-20260515 Phase B Step B.2: 返 sessionId (== applicationSid 不变,
  // 不再调 sessionManager.renameSdkSession — 反向 rename 不动 sessions.id)
  return { fellBack: true, finalSessionId: opts.sessionId };
}
