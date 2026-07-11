/**
 * SessionRecoverer — codex 端断连自愈 + jsonl 兜底（symmetry-plan P2 HIGH-B + MED-E + LOW-A）。
 *
 * 镜像 claude `claude-code/sdk-bridge/recoverer.ts` 同款架构，**精简版**：
 * - claude 1.0 (612 LOC + 6 builder + helpers + LLM 摘要 prepend)
 * - codex 1.0 (Phase 4 Step 4.3 拆分后 facade ~120 LOC + recover-and-send-impl ~280 LOC +
 *   jsonl-discovery ~120 LOC + _deps ~150 LOC，无摘要 prepend / 无 hook 通道)
 *
 * **抽出动机**（R1 reviewer-claude 主题 C HIGH 双方独立 + lead 实证）：
 * 修前 codex `sendMessage` 缺 sessions Map 时直接 `throw new Error('session ${sid} not found')`。
 * app 重启 / dev mode vite hot reload / main process crash 重生 → 内存 sessions Map 空 →
 * 用户在 SessionDetail 输入消息 → renderer 报错红字，**不能继续聊**（必须新建会话，丢上下文）。
 * claude 端走 recoverer 自愈占位 + resume + 体感「掉线但又续上了」，codex 完全缺这条路径。
 *
 * **Phase 4 Step 4.3 拆分布局**:
 * - 本 facade ~120 LOC: SessionRecoverer class shell + thin recoverAndSend delegate +
 *   findFallbackCwd protected method (test override 注入点) + re-export types/helpers
 * - `recoverer/_deps.ts`: RecovererCtx + 4 thunk type + PLACEHOLDER_DEDUP_MS const
 * - `recoverer/recover-and-send-impl.ts`: recoverAndSend method 主体 (~280 LOC)
 * - `recoverer/jsonl-discovery.ts`: 3 helper (defaultCodexResumeJsonlExists / defaultCwdExists /
 *   findThreadJsonlByRecursiveScan)
 *
 * **State 所有权**：
 * - `recovering` Map：**SHARED**，与 facade 持有的同一份 ref（symmetry-plan P2 HIGH-A 已就位），
 *   restartController + recoverer 双方读写同一份单飞表。同 sessionId 同时只有一条 recovery /
 *   restart in-flight。
 * - `placeholderEmittedAt` Map：**recoverer 独占**，5s dedup 同 sessionId 短时间反复 recover
 *   重 emit「⚠ Codex 通道已断开...」噪声（与 claude REVIEW_17 R3 / M3-R3 同款）。
 *
 * **循环依赖回避**（与 claude 同款）：
 * - recoverAndSend 调 facade.createSession（resume / 不带 resume 兜底）→ 走 createThunk
 * - recoverAndSend 调 facade.sendMessage（inflight 等完后递归把第二条 text 正常 push）→ 走 sendThunk
 * - jsonlExistsThunk + cwdExistsThunk 走 thunk 让 test 注入 mock
 *
 * **codex 与 claude 的关键差异**（架构内禀 / SDK 形态）：
 * - codex 无 hook 通道：不调 sessionManager.expectSdkSession（claude 走 hook 路径需要）
 * - **codex 历史注入已与 claude 对称**（plan resume-inject-raw-messages-20260601 §D8 解开
 *   REVIEW_60 F5）：jsonl-missing fallback 起 fresh thread 前走 shared `injectResumeHistory`
 *   （`@main/session/resume-history`）拼「总结段 + 最近原始对话消息段 + 当前消息」。总结段复用
 *   claude oneshot `summariseSessionForHandOff(cwd, events, 'Agent')`（本地 OAuth，agentName='Agent'
 *   让 codex 会话总结不自称「Claude 会话」），不为 codex 写平行总结函数。共享层 maxLength 参数化
 *   解开历史「claude MAX_MESSAGE_LENGTH 常量耦合」。3 thunk（summariseFn / listEventsFn /
 *   listMessagesFn）经 ctor 注入 → codex-jsonl-fallback helper。
 * - codex 不支持 implicit fork：spike-A2 实测 codex CLI resume 永远返回同 thread_id（详
 *   restart-controller line 97 注释）。recoverer 仍保留 post-rename 防御（`if newRealId !== sessionId`）
 *   future-proof 防 SDK 升级 / CLI 行为变更。
 * - codex 无 permissionMode：codex SDK approvalPolicy 写死 'never'（详 codex-cli/index.ts:21）。
 * - codex jsonl 路径与 claude 不同：claude 在 `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`，
 *   codex 在 `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TIMESTAMP>-<thread_id>.jsonl`，
 *   pre-check 算法见 `jsonl-discovery.defaultCodexResumeJsonlExists`。
 *
 * **护栏（与 claude 同款）**：
 * - CHANGELOG_26 — recovering 单飞 + 30s placeholder UX
 * - CHANGELOG_28 — jsonl 预检不在则走不带 resume 的新建 createSession + 事后 renameSdkSession
 * - CHANGELOG_31 — 用户显式发消息触发 recoverAndSend 自动 unarchive
 * - REVIEW_17 R3 — 5s placeholder dedup
 * - CHANGELOG_99 — cwd 失效启发式 fallback
 */
import type { UploadedAttachmentRef } from '@shared/types';
import { findFallbackCwd as findFallbackCwdShared } from '@main/adapters/shared/find-fallback-cwd';
import type {
  CreateSessionThunk,
  CwdExistsThunk,
  JsonlExistsThunk,
  RecovererCtx,
  SendMessageThunk,
  SummariseFnThunk,
  ListEventsFnThunk,
  ListRecentMessagesFnThunk,
} from './recoverer/_deps';
import { recoverAndSendImpl } from './recoverer/recover-and-send-impl';

// Phase 4 Step 4.3 facade re-export — 保 byte-identical external import path
// (`import { SessionRecoverer, defaultCodexResumeJsonlExists, defaultCwdExists } from './recoverer'`
// caller 站点零变更继续工作)
export type {
  RecovererCtx,
  CreateSessionThunk,
  SendMessageThunk,
  JsonlExistsThunk,
  CwdExistsThunk,
} from './recoverer/_deps';
export {
  defaultCodexResumeJsonlExists,
  defaultCwdExists,
} from './recoverer/jsonl-discovery';

export class SessionRecoverer {
  /**
   * 5s dedup 窗口防同 sessionId 短时间反复 recover（与 claude REVIEW_17 R3 同款）。
   */
  private readonly placeholderEmittedAt = new Map<string, number>();

  constructor(
    private readonly ctx: RecovererCtx,
    private readonly createThunk: CreateSessionThunk,
    private readonly sendThunk: SendMessageThunk,
    private readonly jsonlExistsThunk: JsonlExistsThunk,
    private readonly cwdExistsThunk: CwdExistsThunk,
    /**
     * **plan resume-inject-raw-messages-20260601 §D8 修法**: LLM 总结 thunk(test seam)。
     * facade bind `summariseSessionForHandOff(cwd, events, 'Agent')`(复用 claude oneshot 本地
     * OAuth，agentName='Agent' 让 codex 会话总结不自称「Claude 会话」)。解开 REVIEW_60 F5 耦合。
     */
    private readonly summariseFn: SummariseFnThunk,
    /**
     * **plan resume-inject §D7**: 全量 events 来源 thunk(test seam)。facade bind
     * `eventRepo.listForSession`，喂 summariseFn 出六节检查点(总结段数据源)。
     */
    private readonly listEventsFn: ListEventsFnThunk,
    /**
     * **plan resume-inject §D5**: message-only 来源 thunk(test seam)。facade bind
     * `eventRepo.listRecentMessages`，拼「最近原始对话消息段」(双数据源之二)。
     */
    private readonly listMessagesFn: ListRecentMessagesFnThunk,
  ) {}

  /**
   * 断连自愈 — facade thin delegate (详 recoverer/recover-and-send-impl.ts §执行序列)。
   *
   * 调度 recoverAndSendImpl free fn,deps interface 注入 class state + 4 thunk:
   * - ctx (recovering + emit) SHARED with facade.restartController
   * - placeholderEmittedAt Map 独占
   * - 4 thunk 直接转发 ctor 注入的 closure
   * - findFallbackCwd 反调本 class protected method (test override 注入点)
   *
   * **plan cross-adapter-parity-20260515 Phase B Step B.2 — 返回 Promise<string>**:
   * 返回 final session id(fallback path 返 newRealId / resume path 返 sessionId)。修前
   * `Promise<void>` waiter 等 inflight 后用 OLD sessionId 调 sendThunk → bridge.sendMessage
   * 内 sessions Map miss → 又进 recoverAndSend → sessionRepo.get(OLD) 已 rename DELETE → throw
   * "not found" — 用户体感「第二条消息消失」(REVIEW_40 R2 reviewer-codex MED parity 限制)。
   */
  async recoverAndSend(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
  ): Promise<string> {
    return recoverAndSendImpl(sessionId, text, attachments, {
      ctx: this.ctx,
      placeholderEmittedAt: this.placeholderEmittedAt,
      createThunk: this.createThunk,
      sendThunk: this.sendThunk,
      jsonlExistsThunk: this.jsonlExistsThunk,
      cwdExistsThunk: this.cwdExistsThunk,
      // arrow 闭包 this,运行时晚解析 → this.findFallbackCwd 一定已绑定 (test override 注入点)
      findFallbackCwd: (badCwd) => this.findFallbackCwd(badCwd),
      // plan resume-inject-raw-messages-20260601 §D5/§D7/§D8: 3 thunk 透传给 codex-jsonl-fallback
      // 让其调 injectResumeHistory 拼「总结段 + 原始对话段 + 当前消息」(对称 claude)。
      summariseFn: this.summariseFn,
      listEventsFn: this.listEventsFn,
      listMessagesFn: this.listMessagesFn,
    });
  }

  /**
   * cwd 失效启发式 fallback 算法（与 claude `recoverer.ts` `findFallbackCwd` 同款）。
   *
   * 已知 sessionRepo.cwd 不存在时(由 cwdExistsThunk 判定),尝试找一个还能用的 cwd
   * 让 codex CLI 子进程能正常 spawn(否则 chdir 失败,撞 "Path does not exist" 弯绕错误链)。
   *
   * **算法两阶启发式**:
   * 1. **路径含 `.claude/worktrees/` 段** → 取段之前部分（典型: K2 老 session
   *    cwd=worktree 的场景,worktree 删了之后 main repo 仍在）
   * 2. **父目录 walk** → 沿 dirname 链往上找第一个还存在的目录(覆盖手动 git worktree
   *    remove / 误删 / 跨设备同步丢目录等场景)。**安全边界**:不超过 home。
   *
   * 找不到 → null(handler 上层 emit error + throw,不进 placeholder 路径)。
   *
   * **fallback 后下游**:走 createThunk 不带 resume + 后置 renameSdkSession（CLI 历史失但应用层
   * events / file_changes / summaries 子表保留）。
   *
   * **不持久化 fallback cwd**:sessionRepo.cwd 不被改写。理由：fallback 是 best-effort 不动持久
   * state；下次发消息再次 detect → fallback。
   *
   * test 通过 facade extend override 该方法定制启发式行为。
   *
   * **REVIEW_49 R1 follow-up MED-G**: 抽 `findFallbackCwd` 实现到 `@main/adapters/shared/find-fallback-cwd`
   * (与 claude/recoverer.ts:637 同款),本方法保留作为 facade extend override 注入点(test
   * 仍可 override 该 protected method 改启发式)。
   */
  protected findFallbackCwd(badCwd: string): string | null {
    return findFallbackCwdShared(badCwd, this.cwdExistsThunk);
  }
}
