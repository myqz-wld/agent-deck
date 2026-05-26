/**
 * SessionRecoverer — codex 端断连自愈 + jsonl 兜底（symmetry-plan P2 HIGH-B + MED-E + LOW-A）。
 *
 * 镜像 claude `claude-code/sdk-bridge/recoverer.ts` 同款架构，**精简版**：
 * - claude 1.0 (612 LOC + 6 builder + helpers + LLM 摘要 prepend)
 * - codex 1.0 (本文件 ~280 LOC，无摘要 prepend / 无 hook 通道)
 *
 * **抽出动机**（R1 reviewer-claude 主题 C HIGH 双方独立 + lead 实证）：
 * 修前 codex `sendMessage` 缺 sessions Map 时直接 `throw new Error('session ${sid} not found')`。
 * app 重启 / dev mode vite hot reload / main process crash 重生 → 内存 sessions Map 空 →
 * 用户在 SessionDetail 输入消息 → renderer 报错红字，**不能继续聊**（必须新建会话，丢上下文）。
 * claude 端走 recoverer 自愈占位 + resume + 体感「掉线但又续上了」，codex 完全缺这条路径。
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
 * - codex 无 LLM 摘要 prepend：claude 用 `summariseSessionForHandOff` thunk + `prependHistorySummary`
 *   helper 在 fallback 路径起 fresh CLI 之前生成摘要 prepend。codex 现版本暂不接，原因：
 *   `summariseCodexSessionForHandOff` 走 codex SDK 自身（codex 不支持 systemPrompt + 4 节模板
 *   reasoning effort 'medium'），与 claude `summariseSessionForHandOff` 签名差异较大；
 *   shared `prependHistorySummary` helper 现持有 claude `MAX_MESSAGE_LENGTH` 常量耦合。
 *   留独立 follow-up 收口（R37 R3 类似的 INFO 触发条件 — 一并 polish 时合入）。
 * - codex 不支持 implicit fork：spike-A2 实测 codex CLI resume 永远返回同 thread_id（详
 *   restart-controller line 97 注释）。recoverer 仍保留 post-rename 防御（`if newRealId !== sessionId`）
 *   future-proof 防 SDK 升级 / CLI 行为变更。
 * - codex 无 permissionMode：codex SDK approvalPolicy 写死 'never'（详 codex-cli/index.ts:21）。
 * - codex jsonl 路径与 claude 不同：claude 在 `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`，
 *   codex 在 `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TIMESTAMP>-<thread_id>.jsonl`，
 *   pre-check 算法见 `defaultCodexResumeJsonlExists`。
 *
 * **护栏（与 claude 同款）**：
 * - CHANGELOG_26 — recovering 单飞 + 30s placeholder UX
 * - CHANGELOG_28 — jsonl 预检不在则走不带 resume 的新建 createSession + 事后 renameSdkSession
 * - CHANGELOG_31 — 用户显式发消息触发 recoverAndSend 自动 unarchive
 * - REVIEW_17 R3 — 5s placeholder dedup
 * - CHANGELOG_99 — cwd 失效启发式 fallback
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionRecord, UploadedAttachmentRef } from '@shared/types';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { findFallbackCwd as findFallbackCwdShared } from '@main/adapters/shared/find-fallback-cwd';
import { AGENT_ID, MAX_MESSAGE_LENGTH } from './constants';
import type { CodexBridgeOptions, CodexSessionHandle } from './types';

/** 5s dedup 窗口防同 sessionId 短时间内多次 recover 重 emit「⚠ Codex 通道已断开」噪声。 */
const PLACEHOLDER_DEDUP_MS = 5_000;

export interface RecovererCtx {
  /**
   * **SHARED** with restartController.recovering（symmetry-plan P2 HIGH-A 已加 facade 持权威 ref）。
   * 单飞 invariant：同 sessionId 同时只有一条 recovery / restart in-flight。
   */
  readonly recovering: Map<string, Promise<unknown>>;
  readonly emit: CodexBridgeOptions['emit'];
}

export type CreateSessionThunk = (opts: {
  cwd: string;
  prompt: string;
  resume?: string;
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
  attachments?: UploadedAttachmentRef[];
  /**
   * recoverer fallback / resume 路径显式透传 spawn 时持久化的 model（与 claude
   * `recoverer.ts` HIGH-1 同款修法 — fallback 路径不走 resume 时若不显式透传，
   * 已 spawn 的 codex 实际跑默认 model 而 DB record 仍显示原 model）。
   *
   * 注意：codex SDK 不接受 per-thread model override（runtime 由 ~/.codex/config.toml 决定，
   * 详 plan model-wiring-and-handoff-20260514 D5），但 createSession 内部仍 setModel 持久化
   * 让 UI 显示一致 — 保留入参字段对齐 claude 接口形态。
   */
  model?: string;
  /**
   * plan cross-adapter-parity-20260515 Phase A Step A.7 / REVIEW_40 R1 reviewer-codex MED-F:
   * recoverer fallback / resume 路径显式透传 spawn 时持久化的 SDK sandbox 额外可写根。
   *
   * 与 model 字段同款语义:codex SDK 不消费 extra writable roots(sandboxMode 三档无 allowWrite
   * 字段),但 createSession 内部仍 setExtraAllowWrite 持久化保 parity 对称 — 保留入参字段对齐
   * claude 接口形态。**透传到当前不消费的 opts 无副作用**(persistSessionFields 内 if 卫语句
   * skip 空数组,setExtraAllowWrite null 也是合法值)。
   *
   * 修法理由(plan §4 推荐 ✅ 做):即使 codex bridge 当前不消费,持久化字段 + 读回保 parity 完整,
   * future codex SDK 加支持时零迁移成本 + 减跨 adapter 漂移。与 claudeCodeSandbox / model 同款
   * 显式透传 + ?? undefined 兜底(rec.extraAllowWrite 历史 NULL 时 undefined 跳过 setter)。
   */
  extraAllowWrite?: readonly string[];
  /**
   * **plan reverse-rename-sid-stability-20260520 §A.4-pre S1 R6 HIGH-R6-1 + R7 HIGH-R7-1 (codex 对称)**:
   * caller 显式传 cli sid (rec.cliSessionId ?? sessionId) 让 codex SDK resumeThread 拿正确 thread sid。
   */
  resumeCliSid?: string;
  /**
   * **plan reverse-rename-sid-stability-20260520 §A.4-pre S1 R3 HIGH-G + R7 HIGH-R7-1 (codex 对称)**:
   * 'fresh-cli-reuse-app' 让 jsonl-missing fallback 路径显式触发 SDK fresh thread + 复用 applicationSid。
   */
  resumeMode?: 'resume-cli' | 'fresh-cli-reuse-app';
}) => Promise<CodexSessionHandle>;

export type SendMessageThunk = (
  sessionId: string,
  text: string,
  attachments?: UploadedAttachmentRef[],
) => Promise<void>;

/**
 * jsonl 探测 thunk(test seam)。签名与 claude `JsonlExistsThunk` 形态对齐但参数不同：
 * - claude 用 (cwd, sessionId) — jsonl 路径含 encoded cwd
 * - codex 用 (threadId, startedAt) — jsonl 路径含 createdAt 日期段
 *
 * 默认实现 `defaultCodexResumeJsonlExists` 走 fs.readdirSync 扫 startedAt 日期目录。
 * Test 通过 facade extend override 让单测不依赖真 ~/.codex/sessions 目录。
 */
export type JsonlExistsThunk = (threadId: string, startedAt: number) => boolean;

/** cwd 存在性 thunk(test seam)。默认 fs.existsSync。test 通过 facade extend override。 */
export type CwdExistsThunk = (cwd: string) => boolean;

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
  ) {}

  /**
   * 断连自愈：sendMessage 检测 sessions Map 没有该 sessionId 时调本路径。
   *
   * 关键约束（与 claude recoverer 同款）：
   * - 完整复用 createSession，让 createSession 内部全套 protocol 走完
   * - 历史 record 完全不存在时直接抛 'not found'，让 IPC 把错原样透传 renderer
   * - 单飞防并发自愈起多个 codex CLI 子进程
   * - permissionMode 不传（codex 无此概念）；codexSandbox / model 必须显式透传从 sessionRepo
   *   读到的历史值，否则 fallback 路径下静默用全局默认（详 claudeCodeSandbox HIGH-1 教训）
   *
   * **plan cross-adapter-parity-20260515 Phase B Step B.2 — 返回 Promise<string>**:
   * 返回 final session id(fallback path 返 newRealId / resume path 返 sessionId)。修前
   * `Promise<void>` waiter 等 inflight 后用 OLD sessionId 调 sendThunk → bridge.sendMessage
   * 内 sessions Map miss → 又进 recoverAndSend → sessionRepo.get(OLD) 已 rename DELETE → throw
   * "not found" — 用户体感「第二条消息消失」(REVIEW_40 R2 reviewer-codex MED parity 限制)。
   *
   * 修后 waiter 拿 finalId 调 sendThunk(finalId, text, atts),fallback path 走 NEW(主 recovery
   * 完成后 sessions Map 已 rename 同步)直接 push 进 NEW session;resume path finalId === sessionId
   * 行为零变化(codex 不 implicit fork,详 L34 节注释)。失败路径 reject 仍透传(catch 静默
   * fallback finalId=sessionId 让等待者再撞一次触发新一轮 recovery,plan §B.5 设计)。
   */
  async recoverAndSend(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
  ): Promise<string> {
    const inflight = this.ctx.recovering.get(sessionId);
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
      await this.sendThunk(finalId, text, attachments);
      return finalId;
    }

    const rec: SessionRecord | null = sessionRepo.get(sessionId);
    if (!rec) {
      // 没有历史 record：彻底无法恢复，保留原 throw 信号兼容上层处理
      throw new Error(`session ${sessionId} not found`);
    }

    // CHANGELOG_99 cwd 失效根治（与 claude 同款 R1 fix MED-2 顺序：cwd 校验 → unarchive,
    // 避免 archived session cwd fallback 失败前被 unarchive 成 active 但实际死路一条）。
    //
    // symmetry-plan P3 R2-2 (reviewer-claude MED-G):cwd fallback 后 effectiveCwd 仍可走正常 resume
    // (codex jsonl 独立于 cwd,详 L38-40 节注释),不再像 claude 那样强制 fresh thread。
    let effectiveCwd = rec.cwd;
    if (!this.cwdExistsThunk(rec.cwd)) {
      const fallback = this.findFallbackCwd(rec.cwd);
      if (fallback === null) {
        // 真没救：emit 清晰错误,throw,不进 placeholder 路径。
        // **不 unarchive**（archived 状态下 throw,session 仍归档，用户在 SessionList "已归档"
        // 列表能看到清晰错误信息 — 与 claude MED-2 fix 同款）
        this.ctx.emit({
          sessionId,
          agentId: AGENT_ID,
          kind: 'message',
          payload: {
            text:
              `⚠ 会话 cwd 不存在且无可用 fallback：${rec.cwd}。` +
              `请检查目录是否被删除 / 跨设备同步丢失，或新建会话。`,
            error: true,
          },
          ts: Date.now(),
          source: 'sdk',
        });
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
      this.ctx.emit({
        sessionId,
        agentId: AGENT_ID,
        kind: 'message',
        payload: {
          text:
            `⚠ 会话原 cwd 不存在 (${rec.cwd}),已切到 fallback (${effectiveCwd}) 继续 ` +
            `(对话历史保留)。注意:历史中对原 cwd 文件的相对引用 (如 "edit foo.ts at line 10") ` +
            `可能不再指向同一文件,如需精确恢复请新建会话。`,
        },
        ts: Date.now(),
        source: 'sdk',
      });
      console.warn(
        `[codex-bridge] cwd fallback for ${sessionId}: ${rec.cwd} → ${effectiveCwd}`,
      );
    }

    // CHANGELOG_31：用户在 detail 里主动发消息触发 recoverAndSend = 显式表达「我又要聊它了」，
    // 自动取消归档（与 claude 同款）。manager.ts 立的「归档与 lifecycle 正交，不能因事件流自动
    // unarchive」约束针对的是 hook 触发路径，本路径是用户显式 UI 动作不冲突。
    // CHANGELOG_99 R1 fix MED-2 顺序：本段必须在 cwd precheck 之后 — 确认 cwd 能恢复再 unarchive,
    // 避免 cwd fallback 失败 throw 但 session 已被错误 unarchive。
    if (rec.archivedAt !== null) {
      console.warn(
        `[codex-bridge] recoverAndSend on archived session ${sessionId}, auto-unarchiving (user explicitly sending message)`,
      );
      await sessionManager.unarchive(sessionId);
    }

    // MAX_MESSAGE_LENGTH 字符长度上限（与 messageRepo cap 全局对齐）。
    // 恢复路径不能绕过此防线（防超长 prompt 当作恢复路径首条消息送进 createSession）。
    const len = text.length;
    if (len > MAX_MESSAGE_LENGTH) {
      throw new Error(
        `单条消息 ${len.toLocaleString()} 字符超过 ${MAX_MESSAGE_LENGTH.toLocaleString()} 字符上限。请精简或拆分发送。`,
      );
    }

    // 占位 message：起 codex 子进程期间用户至少看到「在恢复」而不是哑巴 busy（与 claude 同款）。
    // 5s dedup 窗口防同 sessionId 短时间内反复 recover 重 emit 多条「⚠ Codex 通道已断开」噪声。
    const lastPlaceholderAt = this.placeholderEmittedAt.get(sessionId);
    const nowTs = Date.now();
    if (lastPlaceholderAt === undefined || nowTs - lastPlaceholderAt > PLACEHOLDER_DEDUP_MS) {
      this.placeholderEmittedAt.set(sessionId, nowTs);
      // 顺手清掉过期 entry（避免 Map 无限涨）
      for (const [k, ts] of this.placeholderEmittedAt) {
        if (nowTs - ts > PLACEHOLDER_DEDUP_MS) this.placeholderEmittedAt.delete(k);
      }
      this.ctx.emit({
        sessionId,
        agentId: AGENT_ID,
        kind: 'message',
        payload: { text: '⚠ Codex 通道已断开，正在自动恢复…' },
        ts: nowTs,
        source: 'sdk',
      });
    }

    const p = (async (): Promise<string> => {
      try {
        // CHANGELOG_28 同款：预检 jsonl 是否存在 — codex CLI resume 时找不到 jsonl 会失败，
        // SDK 抛 "Codex Exec exited with ..." 错误，比 try/catch 后字符串匹配 fallback 更可靠。
        //
        // 触发条件：jsonl 被用户手动清 / 跨设备同步未带 / codex CLI 自身清理。预检使用
        // sessionRepo.startedAt 拿 createdAt 日期定位 ~/.codex/sessions/<YYYY>/<MM>/<DD>/ 目录,
        // 扫 *-<threadId>.jsonl 文件。详 `defaultCodexResumeJsonlExists` 算法。
        //
        // symmetry-plan P3 R2-2 (reviewer-claude MED-G):删 `cwdFellBack ||` 强制 fallback。
        // 修前 cwdFellBack 强制 fresh thread 即使 jsonl 在 — 用户无谓失去对话历史。
        // 实际上 codex jsonl 完全独立于 cwd(date-based 路径,详 L38-40 注释 + L186-188 emit text),
        // codex resumeThread + workingDirectory:effectiveCwd 让 SDK 在 fallback cwd 下 chdir 但仍
        // 拿到原 thread 历史 → 与 claude 行为对称(claude 同款场景下 force fallback 是因为 jsonl
        // 真在 cwd 下,codex 没这个限制)。仅 jsonl 真不在时才走 fresh thread fallback。
        // codex jsonl 文件命名规则:`rollout-<TIMESTAMP>-<thread_id>.jsonl`(见
        // defaultCodexResumeJsonlExists 算法 line 472 `endsWith(\`-${threadId}.jsonl\`)`)
        // → 预检参数必须用 thread_id 维度(= sessions.cli_session_id 列值,反向 rename 后
        // 与 applicationSid 解耦)。同文件 line 370 正常 resume 路径已显式 future-proof
        // 防御 (`rec.cliSessionId ?? sessionId`),本预检入口与之对称。
        // 修前用 `sessionId`(applicationSid 维度) → 反向 rename 后 cliSessionId !== sessionId
        // 时预检永远 miss → falsely trigger fresh thread fallback → 用户失对话历史 + 误导
        // warning。详 reviews/REVIEW_56.md HIGH-1。
        if (!this.jsonlExistsThunk(rec.cliSessionId ?? sessionId, rec.startedAt)) {
          console.warn(
            `[codex-bridge] resume jsonl missing for ${sessionId} (startedAt ${new Date(rec.startedAt).toISOString()}), ` +
              `falling back to new thread (CLI history lost but app DB events/file_changes preserved)`,
          );
          this.ctx.emit({
            sessionId,
            agentId: AGENT_ID,
            kind: 'message',
            payload: {
              text:
                `⚠ Codex 内部对话历史 (jsonl) 已不存在,本会话续聊从 fresh thread 开始 ` +
                `(应用层 events 历史保留)。请下条消息把背景给 Codex 一次。`,
            },
            ts: Date.now(),
            source: 'sdk',
          });
          // fallback 路径：不带 resume + 显式透传 sandbox/model 否则静默降到全局默认（与 claude
          // REVIEW_36 HIGH-1 同款教训）。attachments 透传让首条恢复消息带图。
          // plan cross-adapter-parity-20260515 Phase A Step A.7:extraAllowWrite 同 model 同款显式
          // 透传(codex 不消费但 createSession 内部仍 setExtraAllowWrite 持久化保 parity 对称)。
          // **plan reverse-rename-sid-stability-20260520 §A.4-pre S8 R3 HIGH-G + R5 HIGH-R5-1 +
          // R6 MED-R6-1 + R7 HIGH-R7-1 修订 (codex 对称 claude recoverer.ts:466)**:
          // jsonl-missing fallback 不再创建新 sessions row,改用 resumeMode='fresh-cli-reuse-app'
          // 显式语义 + 复用 applicationSid (sessionId);first realId 后通过 sessionManager.updateCliSessionId
          // 走 manager 黑名单链 (R5 HIGH-R5-1 + R6 MED-R6-1 修订)。
          await this.createThunk({
            cwd: effectiveCwd,
            prompt: text,
            // **R6 MED-R6-1 修订**: resume = applicationSid (复用 caller 入参 sessionId)
            resume: sessionId,
            // **R3 HIGH-G + R7 HIGH-R7-1 修订**: 显式 mode 字段触发 fresh CLI thread + 复用 applicationSid
            resumeMode: 'fresh-cli-reuse-app',
            codexSandbox: rec.codexSandbox ?? undefined,
            model: rec.model ?? undefined,
            extraAllowWrite: rec.extraAllowWrite ?? undefined,
            attachments,
          });
          // plan cross-adapter-parity-20260515 Phase B Step B.2: 返 sessionId (== applicationSid 不变,
          // 不再调 sessionManager.renameSdkSession — 反向 rename 不动 sessions.id)
          return sessionId;
        }

        // 正常 resume 路径：jsonl 在 + cwd 有 → 走 createSession({resume, prompt, codexSandbox, model, attachments})
        // 复用 createSession 内部全套 protocol。
        // plan cross-adapter-parity-20260515 Phase A Step A.7:extraAllowWrite 同 model 同款显式透传。
        // plan cross-adapter-parity-20260515 Phase B Step B.2 + REVIEW_41 MED-2 fix: 拿 handle
        // 反映真实 finalId(codex spike-A2 实测 resume 不 fork → handle.sessionId === sessionId,
        // 但保 future-proof 防 codex SDK 升级 / 行为变更,且与 claude resume path 对称)。
        const handle = await this.createThunk({
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
        });
        // plan cross-adapter-parity-20260515 Phase B Step B.2 + REVIEW_41 MED-2 fix: 与 claude
        // resume path 对称返 handle.sessionId(codex 现实测不 fork 但写法 future-proof)。
        return handle.sessionId;
      } finally {
        this.ctx.recovering.delete(sessionId);
      }
    })();
    this.ctx.recovering.set(sessionId, p);

    try {
      // plan cross-adapter-parity-20260515 Phase B Step B.2: 返 finalId 给 caller(虽 bridge
      // sendMessage 当前 caller 不消费返回值,但等待者 path 经 inflight 拿同款 finalId)。
      return await p;
    } catch (err) {
      // createSession 失败：占位 message 已经 emit，再补一条 error message 让用户看到原因
      this.ctx.emit({
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

/**
 * 默认 codex jsonl 探测 — 扫 ~/.codex/sessions/<YYYY>/<MM>/<DD>/ 找匹配 thread_id 的 rollout 文件。
 *
 * **codex CLI jsonl 路径规则**：
 *   `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TIMESTAMP>-<thread_id>.jsonl`
 *   YYYY/MM/DD = codex 创建 thread 时的本地日期；TIMESTAMP = 同时刻 ISO 字符串
 *
 * **算法**：
 * 1. 用 sessionRepo.startedAt 算 createdAt Date（应用 emit session-start 时取的 Date.now()，
 *    与 codex 自己写 jsonl 的时刻通常差 < 几秒；同日的概率 99%+）
 * 2. 扫 `<sessions>/<YYYY>/<MM>/<DD>/` 找文件名 endsWith `-<thread_id>.jsonl`
 * 3. 找不到就再试 ±1 day（覆盖时区边界 / startedAt 与 codex 实际写 jsonl 的时刻跨日的边角）
 * 4. **REVIEW_56 §F2 修法 (Plan-Review Round 1 + spike1 实证)**: ±1 day fast path miss 后
 *    递归扫整个 sessionsRoot 兑底（覆盖跨 ≥ 2 day false miss 边角:abnormal scenario 如
 *    application crash 长延迟 / 错误 startedAt persist 等）。spike1 实测 1800 files 递归扫
 *    0.052ms / wrong-startedAt fast-path 0.007ms < 1ms 完全可接受
 *    (spike-reports/spike1-jsonl-cross-day.md §case 3/4 + fs 开销 benchmark)
 * 5. 任意异常（fs 权限 / 路径解析失败）→ 返回 true（让 SDK 自己 try，最差不过原行为）
 *
 * 这是 facade.codexResumeJsonlExists 的默认实现；test 通过 extend facade override 该方法
 * 让单测不依赖真 ~/.codex/sessions 目录。
 */
export function defaultCodexResumeJsonlExists(threadId: string, startedAt: number): boolean {
  try {
    const sessionsRoot = join(homedir(), '.codex', 'sessions');
    if (!existsSync(sessionsRoot)) return false;

    const startDate = new Date(startedAt);
    // 扫 startedAt 当天 + ±1 day（共 3 天）覆盖时区边界 — fast path 99%+ 场景
    for (const dayOffset of [0, -1, 1]) {
      const d = new Date(startDate.getTime() + dayOffset * 86_400_000);
      const yyyy = d.getFullYear().toString();
      const mm = (d.getMonth() + 1).toString().padStart(2, '0');
      const dd = d.getDate().toString().padStart(2, '0');
      const dayDir = join(sessionsRoot, yyyy, mm, dd);
      if (!existsSync(dayDir)) continue;
      const files = readdirSync(dayDir);
      if (files.some((f) => f.endsWith(`-${threadId}.jsonl`))) return true;
    }

    // REVIEW_56 §F2 修法: ±1 day miss 后递归扫整个 sessionsRoot 兑底 (跨 ≥ 2 day false miss
    // 覆盖,典型场景需 abnormal scenario,概率低但发生时用户失对话历史,值得 fallback 修)。
    // spike1 实测 fs 开销 < 1ms 完全可接受。
    return findThreadJsonlByRecursiveScan(sessionsRoot, threadId);
  } catch {
    // 任意异常退化返回 true(让 createSession 自己 try),最差不过原行为
    return true;
  }
}

/**
 * **REVIEW_56 §F2 修法**: 递归扫 sessionsRoot/<YYYY>/<MM>/<DD>/ 找 endsWith `-<threadId>.jsonl`
 * 文件。±1 day fast path miss 后兑底用,覆盖跨 ≥ 2 day false miss 边角。
 *
 * 三层 readdirSync (year / month / day),每层 try/catch 跳过非目录 entries (容错)。
 * spike1 实测 1800 files (2y × 6m × 30d × 5f/day) 0.052ms,100k files 估算 < 5ms。
 */
function findThreadJsonlByRecursiveScan(sessionsRoot: string, threadId: string): boolean {
  let years: string[];
  try {
    years = readdirSync(sessionsRoot);
  } catch {
    return false;
  }
  for (const y of years) {
    const yPath = join(sessionsRoot, y);
    let months: string[];
    try {
      months = readdirSync(yPath);
    } catch {
      continue;
    }
    for (const m of months) {
      const mPath = join(yPath, m);
      let days: string[];
      try {
        days = readdirSync(mPath);
      } catch {
        continue;
      }
      for (const d of days) {
        const dPath = join(mPath, d);
        let files: string[];
        try {
          files = readdirSync(dPath);
        } catch {
          continue;
        }
        if (files.some((f) => f.endsWith(`-${threadId}.jsonl`))) return true;
      }
    }
  }
  return false;
}

/**
 * cwd 存在性 thunk 的默认实现 — 直接走 fs.existsSync（与 claude `defaultCwdExists` 同款）。
 *
 * 这是 facade.cwdExists 的默认实现;test 通过 extend facade override 让单测不依赖真 fs。
 *
 * **fail-safe 退化**:任意异常退化返回 true(让 createSession 自己 try),最差不过原行为。
 */
export function defaultCwdExists(cwd: string): boolean {
  try {
    return existsSync(cwd);
  } catch {
    return true;
  }
}
