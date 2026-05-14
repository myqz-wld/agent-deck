/**
 * SessionRecoverer — 断连自愈 + jsonl 兜底（CHANGELOG_52 Step 3d）。
 *
 * 抽自 sdk-bridge.ts 内的 recoverAndSend 方法（~150 行）+ resumeJsonlExists 探测。
 *
 * State 所有权：
 * - `recovering` Map：**SHARED**，与 lifecycle.restartWithPermissionMode 双方读写同一份
 *   单飞表（CHANGELOG_26）。原 plan 错把它当 recoverer 独占，F2 finding 修法：
 *   提到 facade 持有 → ctx 注入。
 * - `placeholderEmittedAt` Map：**recoverer 独占**，5s dedup 同 sessionId 短时间反复 recover
 *   重 emit「⚠ SDK 通道已断开...」噪声（REVIEW_17 R3 / M3-R3）。
 *
 * 循环依赖（F1 修法）：
 * - recoverAndSend 调 facade.createSession（resume / 不带 resume 兜底）→ 走 createThunk
 * - recoverAndSend 调 facade.sendMessage（inflight 等完后递归把第二条 text 正常 push）→ 走 sendThunk
 * - resumeJsonlExists 走 jsonlExistsThunk（test 通过子类化 facade override resumeJsonlExists）
 *
 * 护栏（不变）：
 * - CHANGELOG_26 — recovering 单飞 + 30s placeholder UX
 * - CHANGELOG_28 — jsonl 预检不在则走不带 resume 的新建 createSession + 事后 renameSdkSession
 * - CHANGELOG_31 — 用户显式发消息触发 recoverAndSend 自动 unarchive
 * - REVIEW_7 H1 — 用 createSession 返回值拿 newRealId（不再 entries() 反查 cwd）
 * - REVIEW_17 R3 — 5s placeholder dedup
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SessionRecord, UploadedAttachmentRef } from '@shared/types';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { encodeClaudeProjectDir } from '@main/platform';
import { AGENT_ID, MAX_MESSAGE_LENGTH, PLACEHOLDER_DEDUP_MS } from './constants';
import type { SdkBridgeOptions, SdkSessionHandle } from './types';

export interface RecovererCtx {
  /**
   * **SHARED** with lifecycle.restartWithPermissionMode（F2 修法）。
   * 单飞 invariant：同 sessionId 同时只有一条 recovery / restart in-flight。
   */
  readonly recovering: Map<string, Promise<unknown>>;
  readonly emit: SdkBridgeOptions['emit'];
}

export type CreateSessionThunk = (opts: {
  cwd: string;
  prompt?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  resume?: string;
  teamName?: string;
  attachments?: UploadedAttachmentRef[];
}) => Promise<SdkSessionHandle>;

/**
 * HIGH-1 修法：sendThunk 三参签名，attachments 透传到第二条等待者。
 *
 * 原 plan 漏点：`return this.sendThunk(sessionId, text)` 把 attachments 静默吞掉，
 * 第二条带图的 user message 在 inflight 等待者路径下变纯文本。
 *
 * 透传约束：
 * - 第一条 inflight 的 attachments 走 createThunk（携带 prompt + attachments）
 * - 第二条等待者的 attachments 走 sendThunk（独立 attachments path 集合）
 * - 两条之间不复用 / 不去重，文件路径完全独立（IPC 层为每条 message 各写一批）
 */
export type SendMessageThunk = (
  sessionId: string,
  text: string,
  attachments?: UploadedAttachmentRef[],
) => Promise<void>;

export type JsonlExistsThunk = (cwd: string, sessionId: string) => boolean;

/**
 * CHANGELOG_99：cwd 存在性 thunk(test seam)。默认实现走 node fs `existsSync`,
 * test 通过 facade extend override 让单测不依赖真 fs。
 */
export type CwdExistsThunk = (cwd: string) => boolean;

export class SessionRecoverer {
  /**
   * REVIEW_17 R3 / M3-R3：recoverAndSend 入口 emit 占位 message 的 dedup 窗口。
   * 同 sessionId 短时间内被多次 recover 触发（首次 inflight 失败 swallow + 再次
   * sendMessage 重新进 recoverAndSend）会 emit 多条「⚠ SDK 通道已断开...」噪声。
   * 5s 窗口（PLACEHOLDER_DEDUP_MS）够覆盖单飞失败到下次 sendMessage 的典型间隔。
   */
  private readonly placeholderEmittedAt = new Map<string, number>();

  constructor(
    private readonly ctx: RecovererCtx,
    private readonly createThunk: CreateSessionThunk,
    private readonly sendThunk: SendMessageThunk,
    /**
     * jsonl 探测 thunk —— facade 内部转发给 protected resumeJsonlExists 方法（test 通过
     * extend facade override resumeJsonlExists），保证现有测试范式（TestBridge）不破。
     */
    private readonly jsonlExistsThunk: JsonlExistsThunk,
    /**
     * CHANGELOG_99：cwd 存在性探测 thunk(test seam)。facade 内部转发给 protected
     * cwdExists 方法,默认走 fs.existsSync。
     */
    private readonly cwdExistsThunk: CwdExistsThunk,
  ) {}

  /**
   * 断连自愈 + 单飞复用：sendMessage 检测 sessions Map 没有该 sessionId 时调本路径。
   *
   * 关键约束：
   * - 完整复用 createSession，让 expectSdkSession(cwd) → claimAsSdk(opts.resume) →
   *   dedupOrClaim B 分支兜底 → waitForRealSessionId 全套护栏按原样跑（任何捷径都
   *   会重打开「两条 active record」bug，CLAUDE.md「resume 优先」节）
   * - permissionMode 用户上次主动选过的值复原，不能默认 'default' 否则用户辛苦切到的
   *   plan / acceptEdits 被静默还原
   * - 历史 record 完全不存在时直接抛与原行为一致的 'not found'，让 IPC 把错原样透传 renderer
   */
  async recoverAndSend(
    sessionId: string,
    text: string,
    attachments?: UploadedAttachmentRef[],
  ): Promise<void> {
    const inflight = this.ctx.recovering.get(sessionId);
    if (inflight) {
      // 等同一恢复完成 → 然后正常走完整 sendMessage 流程把这条新 text push 进 sessions。
      // catch 静默：第一波恢复失败时第二条等待者自己再走 sendMessage，要么进新一轮 recovery，
      // 要么拿到真错。不要把第一波的错往第二条上抛 —— 调用方只关心自己这条的成败。
      try {
        await inflight;
      } catch {
        // 第一波恢复已失败，第二条自己再撞一次
      }
      // HIGH-1 修法：attachments 透传给第二条等待者 sendThunk。
      // 原版只 sendThunk(sessionId, text) 静默吞掉 attachments；
      // 这条等待者带的图属于「自己这条 message」与第一条独立，必须走完整 sendMessage 路径。
      return this.sendThunk(sessionId, text, attachments);
    }

    const rec: SessionRecord | null = sessionRepo.get(sessionId);
    if (!rec) {
      // 没有历史 record：彻底无法恢复，保留原 throw 信号兼容上层处理
      throw new Error(`session ${sessionId} not found`);
    }

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
    if (!this.cwdExistsThunk(rec.cwd)) {
      const fallback = this.findFallbackCwd(rec.cwd);
      if (fallback === null) {
        // 真没救:emit 清晰错误,throw,不进 placeholder 路径
        // **不 unarchive**:archived 状态下 throw,session 仍归档,用户在 SessionList "已归档"
        // 列表能看到清晰错误信息(MED-2 fix:之前 unarchive 在前 → throw 后 session 变 active 但死路)
        this.ctx.emit({
          sessionId,
          agentId: AGENT_ID,
          kind: 'message',
          payload: {
            text:
              `⚠ 此会话的 cwd 已不存在: ${rec.cwd}\n` +
              `应用尝试启发式 fallback (含 .claude/worktrees/ 路径反推 / 父目录 walk) 但未找到合适的替代目录。\n` +
              `请新建会话;或如确认这条会话不再需要,可右键归档。`,
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
      cwdFellBack = true;
      // 主动告诉用户 fallback 发生了 + 用了哪个目录(不打 error,info 性质)
      this.ctx.emit({
        sessionId,
        agentId: AGENT_ID,
        kind: 'message',
        payload: {
          text:
            `⚠ 此会话的原 cwd 已不存在: ${rec.cwd}\n` +
            `应用启发式 fallback 到: ${effectiveCwd}\n` +
            `CLI 内部对话历史(jsonl)将丢失,但 SessionDetail 历史完整保留(应用 DB)。`,
        },
        ts: Date.now(),
        source: 'sdk',
      });
      console.warn(
        `[sdk-bridge] cwd fallback for ${sessionId}: ${rec.cwd} → ${effectiveCwd}`,
      );
    }

    // CHANGELOG_31：用户在 detail 里主动发消息触发 recoverAndSend = 显式表达「我又要聊它了」，
    // 自动取消归档。manager.ts:118-121 立的「归档与 lifecycle 正交，不能因事件流自动 unarchive」
    // 约束针对的是 hook 触发的事件流（避免外部 CLI 在同 cwd 跑导致用户刚归档的会话被自动恢复），
    // 本路径是用户显式 UI 动作不冲突。不 unarchive 的话，jsonl 在 + 不 fork 路径（realId === OLD_ID）
    // 下 OLD_ID record 不动，archived_at 还在 → listHistory 仍返回这条 → 用户体感「我都在跟它聊了
    // 但它还在历史列表里」与 CLAUDE.md「凡让用户感觉像新开会话 / 跳回列表都是 bug」总纲冲突。
    // unarchive 内部 emit session-upserted，HistoryPanel 监听后自动 reload 把这条从历史列表移除。
    //
    // CHANGELOG_99 R1 fix MED-2:本段移到 cwd precheck **之后** — 确认 cwd 能恢复(原 cwd 在 OR
    // fallback cwd 找到)再 unarchive,避免 cwd fallback 失败 throw 但 session 已被错误 unarchive。
    if (rec.archivedAt !== null) {
      console.warn(
        `[sdk-bridge] recoverAndSend on archived session ${sessionId}, auto-unarchiving (user explicitly sending message)`,
      );
      await sessionManager.unarchive(sessionId);
    }

    // REVIEW_24 HIGH-2 follow-up：字符长度上限（与 messageRepo cap 全局对齐）。
    // 恢复路径不能绕过此防线（防超长 prompt 当作恢复路径首条消息送进 createSession）。
    const len = text.length;
    if (len > MAX_MESSAGE_LENGTH) {
      throw new Error(
        `单条消息 ${len.toLocaleString()} 字符超过 ${MAX_MESSAGE_LENGTH.toLocaleString()} 字符上限。请精简或拆分发送。`,
      );
    }

    // 占位 message：30s fallback 期间用户至少看到「在恢复」而不是哑巴 busy。
    // 不打 error: true（不是错误，是状态提示）；resume 成功后正常 message 流接续，
    // 占位 message 留在活动流上一行轻量「断开过」痕迹，对回看 / 调试反而有用。
    //
    // REVIEW_17 R3 / M3-R3：5s dedup 窗口防同 sessionId 短时间内反复 recover 重 emit
    // 多条「⚠ SDK 通道已断开」噪声（场景：首次 recover 失败 swallow + 再次 sendMessage
    // 又进 recoverAndSend，inflight 已删，第二条进来无条件 emit，用户在 detail 看到
    // 多条同款占位）。
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
        payload: { text: '⚠ SDK 通道已断开，正在自动恢复…' },
        ts: nowTs,
        source: 'sdk',
      });
    }

    const p = (async () => {
      try {
        // CHANGELOG_28：预检 jsonl 是否存在 —— CLI 在 resume 时若找不到
        // ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl 会 hard fail 抛
        // "No conversation found with session ID: <sid>"，consume 内 catch 吞错只 emit
        // 一条「⚠ SDK 流中断」error message + finally emit session-end，createSession 本身
        // 不抛错（waitForRealSessionId 拿不到 first session_id 走 30s fallback 用 tempKey 兜底
        // → 注册一个无实际 SDK 状态的占位 session）。这种场景对用户表现：detail 卡在
        // 「⚠ SDK 通道已断开」+ 「⚠ SDK 流中断」+ 「会话结束」三条红字之间，再发还是同样错。
        //
        // 触发条件：jsonl 被 CLI 自身清理 / 用户手动删过 / 跨设备同步未带 jsonl 等。预检比
        // try/catch 后 fallback 更可靠（不依赖 SDK 错误字符串匹配，正是 P12 教训）。
        // 不存在时直接走不带 resume 的新建路径，事后手工 rename OLD_ID → newRealId 把
        // 应用层 events / file_changes / summaries 子表迁过去（CLI jsonl 历史失，但应用层 DB
        // 历史保留 + sessionId 切换链路与 fork detection 路径一致）。
        //
        // CHANGELOG_99:cwd fallback 时(cwdFellBack=true)强制走 fallback 路径,因为 jsonl 文件
        // 在 OLD cwd encoded 路径下,新 cwd encoded path 必然不存在 → resume 无意义。
        if (cwdFellBack || !this.jsonlExistsThunk(effectiveCwd, sessionId)) {
          if (!cwdFellBack) {
            console.warn(
              `[sdk-bridge] resume jsonl missing for ${sessionId} @ ${effectiveCwd}, ` +
                `falling back to new CLI session (CLI history lost but app DB preserved)`,
            );
            // CHANGELOG_106 bug fix:对称化 cwdFellBack=true 路径(L161-194)— jsonl missing
            // 也是「CLI 历史失但应用层 DB 历史保留」的 fresh CLI 路径,必须 emit 告诉用户,
            // 否则 SessionDetail 看到完整历史 + Claude 答非所问 = 用户问「你是不是没有
            // 历史会话信息了」(实测用户报)。原版只 console.warn 用户看不到;cwdFellBack
            // 路径已 emit 同款警告,本路径补齐让两个 fallback 分支 UX 一致。
            //
            // 触发时机:dormant session 唤醒发消息 → recoverAndSend → cwd 仍在但 jsonl 缺
            // (典型: 用户清 ~/.claude/projects / 跨设备同步漏 jsonl / CLI 自己清理 / 应用
            // 重装 jsonl 没带过来)。
            //
            // 用 info 性质(不打 error: true)— 与 cwdFellBack 路径一致,因为这是设计内的
            // graceful 兜底;打 error 会让时间线像系统崩,误导。
            this.ctx.emit({
              sessionId,
              agentId: AGENT_ID,
              kind: 'message',
              payload: {
                text:
                  `⚠ 此会话的 CLI 内部对话历史(jsonl)已丢失: ${effectiveCwd}\n` +
                  `典型原因: 用户清理 ~/.claude/projects / 跨设备同步未带 jsonl / CLI 自身清理 / 应用重装。\n` +
                  `应用 DB 的 SessionDetail 历史完整保留(本面板看到的对话仍在),但 Claude 这条新启动的 CLI ` +
                  `不知前情。如要继续之前话题,请在下条消息里把背景再告诉它一次。`,
              },
              ts: Date.now(),
              source: 'sdk',
            });
          }
          // REVIEW_7 H1：直接用 createSession 返回值拿 newRealId，不再 entries() 反查 cwd。
          // 旧版用 `for ... entries() if cwd === rec.cwd break` 取 first 推断「最新创建的」，
          // 但 Map 迭代是插入顺序——同 cwd 已存在别的 SDK 会话时会先取到那条历史 session_id，
          // 把 OLD_ID 的 events/file_changes/summaries 子表错迁到不相关会话上。
          const handle = await this.createThunk({
            cwd: effectiveCwd, // CHANGELOG_99:可能是 fallback cwd
            prompt: text,
            permissionMode: rec.permissionMode ?? undefined,
            // HIGH-1 修法：attachments 透传，jsonl 缺失 fallback 路径下恢复也带图
            attachments,
          });
          const newRealId = handle.sessionId;
          if (newRealId !== sessionId) {
            console.warn(
              `[sdk-bridge] post-fallback rename ${sessionId} → ${newRealId} ` +
                `(carry app-side events/file_changes/summaries history)`,
            );
            // REVIEW_7 M1+M3：renameSdkSession 内聚 claim 转移（M3）；包 try/catch 透传错误（M1）。
            // sessionRepo.rename 内事务保证数据原子（要么全迁要么不动），rename 抛错时 OLD claim
            // 没动（M3 后 sdkOwned 转移在 rename 后；rename 抛在 sdkOwned 操作前）。
            // 不 throw —— NEW_ID 通道已建立，rename 只是 best-effort history carry，
            // throw 会让用户的 sendMessage 失败，影响主路径。
            try {
              sessionManager.renameSdkSession(sessionId, newRealId);
            } catch (renameErr) {
              console.error(
                `[sdk-bridge] post-fallback rename failed ${sessionId} → ${newRealId}, ` +
                  `NEW_ID session still works but app-side history not migrated.`,
                renameErr,
              );
            }
          }
          return;
        }

        await this.createThunk({
          cwd: effectiveCwd, // CHANGELOG_99:正常 resume 路径下 cwd 存在,effectiveCwd === rec.cwd
          prompt: text,
          resume: sessionId,
          // permissionMode null = 用户没主动选过，按 createSession 内默认 'default'；
          // 已选过的（acceptEdits / plan / bypassPermissions）必须复原，否则用户体感
          // 「我设过的权限模式被悄悄重置」
          permissionMode: rec.permissionMode ?? undefined,
          // HIGH-1 修法：attachments 透传，正常 resume 路径下首条恢复消息带图
          attachments,
        });
      } finally {
        this.ctx.recovering.delete(sessionId);
      }
    })();
    this.ctx.recovering.set(sessionId, p);

    try {
      await p;
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
   * CHANGELOG_99 cwd 失效根治:启发式 fallback 算法。
   *
   * 已知 sessionRepo.cwd 不存在时(由 cwdExistsThunk 判定),尝试找一个还能用的 cwd
   * 让 SDK 子进程能正常 spawn(否则 chdir 失败,撞 "Path does not exist" 弯绕错误链)。
   *
   * **算法两阶启发式**:
   * 1. **路径含 `.claude/worktrees/` 段** → 取段之前部分(典型: K2 老 session
   *    cwd=worktree 的场景,worktree 删了之后 main repo 仍在)
   * 2. **父目录 walk** → 沿 dirname 链往上找第一个还存在的目录(覆盖手动 git worktree
   *    remove / 误删 / 跨设备同步丢目录等场景)。**安全边界**:不超过 home(避免 fallback
   *    到 `/` / `/Users/<user>` 这种用户不希望的位置;走到这种边界时返回 null)。
   *
   * 找不到 → null(handler 上层 emit error + throw,不进 placeholder 路径)。
   *
   * **fallback 后下游**:走 createThunk 不带 resume + 后置 renameSdkSession(jsonl missing
   * fallback 同款路径,CHANGELOG_28),CLI 历史失但应用层 events / file_changes / summaries
   * 子表保留(用户在 SessionDetail 看到的对话历史完全保留,因为 SessionDetail 渲染走 events
   * 表不走 CLI jsonl)。
   *
   * **不持久化 fallback cwd**:sessionRepo.cwd 不被改写。理由:fallback 是 best-effort 不动
   * 持久 state;下次发消息再次 detect → fallback,不贵(existsSync + regex)。让用户看
   * SessionDetail 还是认识"原本是哪个 worktree 的"history。
   *
   * test 通过 facade extend override 该方法定制启发式行为。
   */
  protected findFallbackCwd(badCwd: string): string | null {
    // 启发式 1:K2 老 session 模式(`<main-repo>/.claude/worktrees/<plan-id>(/.+)?` → 取 <main-repo>)
    // CHANGELOG_99 R1 fix MED-3:regex 改为允许 worktree **内子目录** 命中 main repo
    // (caller cwd 进过 worktree 子目录如 `/repo/.claude/worktrees/plan/src`,worktree 删了
    // parent walk 命中 `.claude/worktrees` 而不是 main repo,违反"启发式 1 优先 main repo"语义)
    const m = badCwd.match(/^(.+)\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/);
    if (m && this.cwdExistsThunk(m[1])) {
      return m[1];
    }
    // 启发式 2:父目录 walk(不超过 home,避免 fallback 到 `/` / `/Users/<user>`)
    // CHANGELOG_99 R1 fix LOW-2:安全边界改为「p 不能是 home 也不能是 home 的祖先」,
    // 避免 badCwd === home 这种边角下 walk 到 `/Users` 等位置(原版只 p === home 比较不够)。
    const home = homedir();
    let p = dirname(badCwd);
    for (let i = 0; i < 32; i++) {
      // p 是 `/` / home 本身 / home 的祖先(`/Users` / `/`)/ 长度 ≤ 1 → 边界拒绝
      const isAncestorOfHome = home === p || home.startsWith(p + '/');
      if (p === '/' || isAncestorOfHome || p.length <= 1) return null;
      if (this.cwdExistsThunk(p)) return p;
      const next = dirname(p);
      if (next === p) return null; // 已到根
      p = next;
    }
    return null;
  }
}

/**
 * 预检 CLI resume 用的 jsonl 文件是否存在。
 *
 * Claude Code CLI 把会话历史落在 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`，
 * encoded-cwd 规则见 `@main/platform` 的 `encodeClaudeProjectDir`（macOS/Linux 用 `/`
 * split + `-` join；Win 推测同模式但用 `\` split）。
 *
 * 不存在时 CLI `--resume <sid>` 会 hard fail 抛 "No conversation found"，必须走不带
 * resume 的新建路径（CHANGELOG_28）。如果 CLI 内部规则未来改了 / Win 实际规则与推测
 * 不符，预检会假阴性 → 退化到原 try-and-fail 行为（catch 兜底返 true，让上层 SDK
 * 自己 try）。
 *
 * 这是 facade.resumeJsonlExists 的默认实现；test 通过 extend facade override 该方法
 * 让单测不依赖真 ~/.claude/projects 目录。
 */
export function defaultResumeJsonlExists(cwd: string, sessionId: string): boolean {
  try {
    const encodedDir = encodeClaudeProjectDir(cwd);
    const jsonlPath = join(homedir(), '.claude', 'projects', encodedDir, `${sessionId}.jsonl`);
    return existsSync(jsonlPath);
  } catch {
    // 任意异常（cwd 解析失败 / FS 权限）→ 退化让 createSession 自己 try，最差不过原行为
    return true;
  }
}

/**
 * CHANGELOG_99:cwd 存在性 thunk 的默认实现 — 直接走 fs.existsSync。
 *
 * 这是 facade.cwdExists 的默认实现;test 通过 extend facade override 让单测不依赖真 fs。
 *
 * **fail-safe 退化**:任意异常退化返回 true(让 createSession 自己 try),最差不过原行为
 * (撞 SDK "Path does not exist")。这与 defaultResumeJsonlExists 同款防御策略。
 */
export function defaultCwdExists(cwd: string): boolean {
  try {
    return existsSync(cwd);
  } catch {
    return true;
  }
}
