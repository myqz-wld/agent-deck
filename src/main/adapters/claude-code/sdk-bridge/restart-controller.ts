/**
 * CHANGELOG_74 Step 3：把 ClaudeSdkBridge 的 restartWithPermissionMode 抽出来 +
 * 新加 restartWithClaudeCodeSandbox。两个方法语义高度同构（emit 占位 → close →
 * 改 DB → createSession resume → 失败回滚 + emit error），适合放一处共管。
 *
 * 与 PermissionResponder / SessionRecoverer / StreamProcessor sub-module 同模式
 * （CHANGELOG_52）：通过 RestartCtx 注入 facade 共享 ref（recovering Map / emit），
 * 通过 thunk 反调 facade 的 closeSession / createSession（不直接持有 facade，避免循环引用）。
 *
 * 不持有 sessions Map：close + createSession 已隐含管理，restart 路径无需直接 mutate。
 */
import { sessionRepo } from '@main/store/session-repo';
import { eventBus } from '@main/event-bus';
import { AGENT_ID } from './constants';
import { maybeJsonlFallback } from './jsonl-fallback';
import type { CapturedRecoveryContinuation } from '@main/session/continuation-context/recovery';
import type { RestartCtx } from './restart-controller-types';
import log from '@main/utils/logger';

export type { RestartCreateOpts, RestartCtx } from './restart-controller-types';

const logger = log.scope('claude-restart-controller');

export class RestartController {
  constructor(private ctx: RestartCtx) {}

  /**
   * 冷切权限模式：销毁旧 SDK 子进程，用新 mode 重建（复用 createSession 的 H4/H1 全套护栏）。
   *
   * 为什么不能用 setPermissionMode 热切？
   * - bypassPermissions 真正的开关是 createSession 时的 `allowDangerouslySkipPermissions: true` flag，
   *   CLI 子进程**初启时**按此 flag 锁死，运行时调 query.setPermissionMode('bypassPermissions')
   *   会被 SDK 静默吞，用户体感「切了但还在询问」。
   *
   * 为什么 handoffPrompt 必须非空？
   * - createSession 入口校验 prompt.trim() 非空（streaming 协议必须有首条 user message 才能启 CLI）。
   * - 调用方负责拼好语义（例如内部重启恢复指令或「用户已批准 plan…请直接执行」）。
   *
   * 单飞：与 sendMessage 触发的 recoverAndSend 共用 `ctx.recovering` Map，
   * 同 sessionId 的并发 cold-restart / connection-loss recovery 排队执行。
   *
   * 失败：snapshot oldMode → DB 已先翻新 mode → createSession fail 时回滚 DB +
   * emit error message 让 UI 下拉回弹。**不**重新 emit 已 settle 的 ExitPlanMode entry
   * （resolver 已 deny+interrupt 过一次，re-emit 假 row 用户点了 silently no-op）。
   *
   * @returns 重启后的真实 sessionId（CLI 隐式 fork 时会变；rename 后 OLD/NEW 都指向同条 DB record）
   */
  async restartWithPermissionMode(
    sessionId: string,
    mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions',
    handoffPrompt: string,
  ): Promise<string> {
    if (!handoffPrompt.trim()) {
      throw new Error('restartWithPermissionMode 要求 handoffPrompt 非空（SDK streaming 协议约束）');
    }

    // 单飞：等同 sessionId 的 in-flight recovery / restart 完成
    // plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.6 修法 (A1-MED-2 codex):
    // 旧版 `if (inflight)` 单等一次 → multi waiter race。3 个 caller 同时进入,inflight=A,
    // A finally 释放 recovering Map → waiter B 拿到 lock + set 新 promise,但 waiter C 还在
    // await A,A resolve 后 C 直接进 close+createSession 跟 B 并发(close OLD twice、写 DB
    // 二次、createSession 两个 SDK 子进程,DB final 状态依赖竞速顺序)。修法:循环 re-check
    // recovering Map 直到为空再继续,保证任意时刻只 1 个 inflight + 后续 waiter 依次 chain。
    //
    // **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 2.9 修法**（M3 codex A1 MED-3）：
    // inflight wait 期间另一并发 caller 可能触发 SDK fork rename (CHANGELOG_27 / REVIEW_6 CLI
    // 隐式 fork) — sessions Map / DB record 的 sessionId 从 OLD → NEW 改名。本路径若仍用入参
    // sessionId 查 sessionRepo.get / 调 closeSession → 后续都用 OLD id (NEW id 的 record 在
    // sessionManager.renameSdkSession 后已是 SSOT) → close OLD miss / setPermissionMode 写 OLD
    // record (已 delete) / createSession resume OLD jsonl 找不到。
    //
    // 修法：listen session-renamed event，inflight wait 期间 fork rename 后更新 local sid ref
    // (currentSid)。finally 注销 listener 防 leak。
    //
    // **R3 plan-review codex Batch A HIGH-1 follow-up**：listener 同时把 `recovering` Map entry
    // 从 OLD 转移到 NEW，否则 set(OLD, p) 在 listener 改 currentSid 后 delete(NEW, p) 留 OLD
    // stale Promise 永驻 → 后续 OLD caller 撞死循环 `while (inflight)` 反复 await done promise；
    // 同时 NEW caller 在 in-flight 期间 lookup NEW 没 lock → 绕过单飞 → 并发执行第二个 restart
    // → race。transfer Map entry 后两个问题同款解决。
    let currentSid = sessionId;
    let recoveryCapture: CapturedRecoveryContinuation | null = null;
    let recoveryCaptureError: unknown;
    const renameListener = (payload: { from: string; to: string }): void => {
      if (payload.from === currentSid) {
        // R3 codex A HIGH-1 修法：transfer recovering Map entry from OLD → NEW。
        // listener 同步执行（event-bus.ts:94-103），rename emit 时 set(OLD, p) 已发生，
        // 此处把 OLD entry 删 + 同 promise 放到 NEW key 让 finally delete(currentSid=NEW)
        // 配对正确 + NEW caller lookup NEW 命中 lock 不绕过单飞。
        const oldPromise = this.ctx.recovering.get(currentSid);
        if (oldPromise) {
          this.ctx.recovering.delete(currentSid);
          this.ctx.recovering.set(payload.to, oldPromise);
        }
        currentSid = payload.to;
      }
    };
    eventBus.on('session-renamed', renameListener);
    try {
      let inflight = this.ctx.recovering.get(currentSid);
      while (inflight) {
        try {
          await inflight;
        } catch {
          // 上一个 recovery 失败不影响本次重启尝试
        }
        // Phase 2.9：每次 re-check 用 currentSid (fork rename 后已更新)，防 inflight wait 期间
        // fork 让 OLD id 的 inflight 已结束但 NEW id 上仍有 inflight
        inflight = this.ctx.recovering.get(currentSid);
      }

      const rec = sessionRepo.get(currentSid);
      if (!rec) throw new Error(`session ${currentSid} not found in repo`);
      const oldMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' =
        rec.permissionMode ?? 'default';

      // Freeze the old conversation before the restart placeholder/close events mutate history.
      // Capture failure is deferred so a valid native jsonl can still resume normally.
      try {
        recoveryCapture = this.ctx.captureRecoveryContinuation({
          session: rec,
          overrides: { permissionMode: mode },
        });
      } catch (error) {
        recoveryCaptureError = error;
        logger.warn(`[claude-restart] continuation capture failed for ${currentSid}`, error);
      }

      // 占位 message：分方向文案，让用户在 5-10s busy 期间看到状态
      // Phase 2.9: 用 currentSid 让 emit 落到正确 session（fork rename 后 NEW id）
      const enterBypass = mode === 'bypassPermissions';
      const placeholderText = enterBypass
        ? '⚠ 正在切换到完全免询问模式（bypass），重启 SDK 中…'
        : `⚠ 正在切换权限模式到 ${mode}，重启 SDK 中…`;
      this.ctx.emit({
        sessionId: currentSid,
        agentId: AGENT_ID,
        kind: 'message',
        payload: { text: placeholderText },
        ts: Date.now(),
        source: 'sdk',
      });

      // REVIEW_36 R2 MED-B 修法：单飞标记必须在 closeSession + DB write + createSession **之前**
      // set，覆盖整个冷重启的副作用窗口。原实现 inflight 检查后直到 createSession promise 建好才 set，
      // 两个并发 restart 都能越过 inflight 检查，同时进入 close → DB write 阶段，结果交错。
      // 修法：先建 placeholder Promise + set 到 recovering Map，让后续并发 restart inflight 检查命中
      // 等待本次完成；再串行跑 close → DB → createSession。
      const p = (async (): Promise<string> => {
        // close OLD：内部已修为 emit *-cancelled 事件清 renderer zombie row 后再清 Map
        // Phase 2.9: 用 currentSid 让 close 操作落到正确 record
        await this.ctx.closeSession(currentSid, { markRecentlyDeleted: false });

        // 写 DB：必须先于 createSession（cold path 翻序；hot path 不动保持 ipc.ts:451-462 原样）。
        // 同步 emit upsert 让 SessionDetail 下拉值立即跟到新 mode（5-10s busy 期间用户已经看到「切完了」）。
        sessionRepo.setPermissionMode(currentSid, mode);
        const updatedRec = sessionRepo.get(currentSid);
        if (updatedRec) eventBus.emit('session-upserted', updatedRec);

        try {
          // **plan restart-controller-jsonl-precheck-20260521 §Step 3d 修法**:
          // jsonl 预检 + fallback (jsonl 缺失走 fresh-cli-reuse-app + helper 内部续历史摘要 +
          // emit fallback info + emit role='user';不变量 11 helper 已包办 createSession + 2 emit)。
          // fellBack=false（jsonl 在）时走正常 resume，**不**注入 DB 历史：CLI `--resume` 会从
          // jsonl 续上完整上下文，再注入 DB 摘要/原始对话只会让模型把整段历史当成新输入（CHANGELOG_221
          // 曾在此注入，CHANGELOG_223 撤回）。仅 jsonl 缺失的 fallback 路径才靠 maybeJsonlFallback 续历史。
          const fbResult = await maybeJsonlFallback(
            {
              jsonlExistsThunk: this.ctx.jsonlExistsThunk,
              jsonlMtimeMsThunk: this.ctx.jsonlMtimeMsThunk,
              createSession: this.ctx.createSession, // RestartCreateOpts 的 createSession (覆盖 JsonlFallbackCreateOpts 子集)
              prepareRecoveryContinuation: this.ctx.prepareRecoveryContinuation,
              emit: this.ctx.emit,
              latestConversationMessageTsThunk: this.ctx.latestConversationMessageTsThunk,
            },
            {
              sessionId: currentSid,
              cliSessionId: rec.cliSessionId ?? null, // SessionRecord.cliSessionId 是 optional (?: string | null) → ?? null 兜底
              cwd: rec.cwd,
              prompt: handoffPrompt,
              recoveryCapture,
              recoveryCaptureError,
              minHealJsonlMtimeMs: rec.lastEventAt,
              provider: rec.runtimeProvider ?? undefined,
              permissionMode: mode,
              claudeCodeSandbox: rec.claudeCodeSandbox ?? undefined,
              extraAllowWrite: rec.extraAllowWrite ?? undefined,
              cwdFellBack: false,
              emitContext: 'restart',
              restartLabel: `权限模式 ${mode}`, // discriminated union 'restart' 分支必填
            },
          );
          if (fbResult.fellBack) {
            return fbResult.finalSessionId; // == currentSid (不变量 3 applicationSid 全程不变)
          }

          await this.ctx.createSession({
            cwd: rec.cwd,
            prompt: handoffPrompt,
            resume: currentSid,
            provider: rec.runtimeProvider ?? undefined,
            // **plan reverse-rename-sid-stability-20260520 §C.1 R3 MED-R3-2 修订**:
            // 反向 rename 后 currentSid 是 applicationSid;SDK CLI `--resume` 需 cli sid 找 jsonl。
            // caller 显式传 cliSessionId 兜底,反向 rename 后两者不同时才生效(否则字面等价旧行为)。
            // **CHANGELOG_224 幻影 fork 自愈**: healedCliSessionId 命中时切到它(= currentSid),
            // 防 rec.cliSessionId 那个幻影 id 让 CLI `--resume` hard-fail 退 fresh-cli。
            resumeCliSid: fbResult.healedCliSessionId ?? rec.cliSessionId ?? currentSid,
            permissionMode: mode,
            // plan cross-adapter-parity-20260515 + REVIEW_41 MED-3 fix:rec.claudeCodeSandbox /
            // rec.extraAllowWrite 必须透传,否则冷重启后 SDK 子进程 sandbox.allowWrite 丢失原
            // 用户透传的 mainRepo (典型 hand_off_session 外置 worktree caller 传 [mainRepo] 让
            // session 能写 mainRepo plan 文件)。与 createSession opts.claudeCodeSandbox /
            // recoverer fallback 路径同款显式透传 + ?? undefined 兜底。
            claudeCodeSandbox: rec.claudeCodeSandbox ?? undefined,
            extraAllowWrite: rec.extraAllowWrite ?? undefined,
          });
          // **plan reverse-rename-sid-stability-20260520 §C.1 反向 rename 修订**:
          // handle.sessionId === currentSid (S5 修订让 createSession 返 internal.applicationSid;
          // resume 路径下 applicationSid 全程不变 = currentSid)。CLI 真实 fork 由
          // bridge stream-processor S6 fork detect 内部走 sessionManager.updateCliSessionId
          // 黑名单链处理 (cli_session_id 列单点 UPDATE,不动 sessions.id)。
          // 此处不再调 sessionManager.renameSdkSession (反向 rename 不动 sessions.id)。
          return currentSid; // application sid 稳定 (与 §不变量 1 对齐)
        } catch (err) {
          // 回滚：DB 改回 oldMode + emit upsert 让下拉回弹
          sessionRepo.setPermissionMode(currentSid, oldMode);
          const rolled = sessionRepo.get(currentSid);
          if (rolled) eventBus.emit('session-upserted', rolled);
          // 占位 message 已 emit 过，再 emit 一条 error 让用户知道失败 + 已回退
          this.ctx.emit({
            sessionId: currentSid,
            agentId: AGENT_ID,
            kind: 'message',
            payload: {
              text:
                `⚠ 切到 ${mode} 失败：${(err as Error)?.message ?? String(err)}。` +
                `权限模式已回退到 ${oldMode}，请重新发送一条消息让 Claude 续上 plan。`,
              error: true,
            },
            ts: Date.now(),
            source: 'sdk',
          });
          throw err;
        }
      })();
      this.ctx.recovering.set(currentSid, p);
      try {
        return await p;
      } finally {
        this.ctx.recovering.delete(currentSid);
      }
    } finally {
      if (recoveryCapture) {
        try {
          this.ctx.cleanupRecoveryContinuation(recoveryCapture);
        } catch (cleanupError) {
          logger.warn(
            `[claude-restart] continuation cleanup failed for ${currentSid}`,
            cleanupError,
          );
        }
      }
      // Phase 2.9: 注销 rename listener 防 leak (event-bus 长生命周期，listener 不清会持续监听)
      eventBus.off('session-renamed', renameListener);
    }
  }

  /**
   * 冷切 OS 沙盒（CHANGELOG_74）：与 restartWithPermissionMode 字面镜像。
   * 销毁旧 SDK 子进程 + 用新 sandbox 档位 createSession resume 重建。
   *
   * 为什么必须冷切？
   * - Claude SDK 的 sandbox options 是 query() spawn-time 锁定，运行时无法热切。
   *   重启子进程 + 在 createSession 内重新拼 buildSandboxOptions 才生效。
   *
   * Confirm 策略由 ComposerSdk 处理：切到 `'off'` = 关闭沙盒 = 放宽 → 弹 confirm；
   * 切到 `'workspace-write'` / `'strict'` = 同档/更严格 → 不 confirm。本方法不做策略，只做执行。
   *
   * 失败：snapshot oldSandbox → DB 已先翻新档 → createSession fail 时回滚 DB + emit error。
   *
   * @returns 重启后的真实 sessionId（与 restartWithPermissionMode 同模式，CLI 隐式 fork 兜底 rename）
   */
  async restartWithClaudeCodeSandbox(
    sessionId: string,
    sandbox: 'off' | 'workspace-write' | 'strict',
    handoffPrompt: string,
  ): Promise<string> {
    if (!handoffPrompt.trim()) {
      throw new Error(
        'restartWithClaudeCodeSandbox 要求 handoffPrompt 非空（SDK streaming 协议约束）',
      );
    }

    // 单飞（与 restartWithPermissionMode 共享 recovering Map）
    // plan deep-review-batch-a1-b-fixes-20260519 §Phase 3 Step 3.6 修法 (A1-MED-2 codex):
    // 同 restartWithPermissionMode 修法 — `if (inflight)` 改 `while (inflight)` 循环 re-check
    // 防 multi waiter race。详上方 restartWithPermissionMode 同款修法 jsdoc。
    //
    // **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase R3 fix-1 修法**
    // （R3 plan-review claude MED-1 + codex Batch A HIGH-1 合并升级）：
    // restartWithClaudeCodeSandbox 之前**完全没改** Phase 2.9（不对称漏修）→ inflight wait
    // 期间 fork rename 后用 OLD sessionId 查 sessionRepo / closeSession / setClaudeCodeSandbox
    // / createSession resume / renameSdkSession 全错。同款 listener + currentSid ref + transfer
    // Map entry 三件套（详 restartWithPermissionMode 同款修法 jsdoc + R3 codex A HIGH-1 transfer
    // Map entry 防 stale entry / NEW caller 绕过单飞）。
    let currentSid = sessionId;
    let recoveryCapture: CapturedRecoveryContinuation | null = null;
    let recoveryCaptureError: unknown;
    const renameListener = (payload: { from: string; to: string }): void => {
      if (payload.from === currentSid) {
        const oldPromise = this.ctx.recovering.get(currentSid);
        if (oldPromise) {
          this.ctx.recovering.delete(currentSid);
          this.ctx.recovering.set(payload.to, oldPromise);
        }
        currentSid = payload.to;
      }
    };
    eventBus.on('session-renamed', renameListener);
    try {
      let inflight = this.ctx.recovering.get(currentSid);
      while (inflight) {
        try {
          await inflight;
        } catch {
          // 上一个失败不影响本次
        }
        inflight = this.ctx.recovering.get(currentSid);
      }

      const rec = sessionRepo.get(currentSid);
      if (!rec) throw new Error(`session ${currentSid} not found in repo`);
      const oldSandbox: 'off' | 'workspace-write' | 'strict' | null =
        rec.claudeCodeSandbox ?? null;

      try {
        recoveryCapture = this.ctx.captureRecoveryContinuation({
          session: rec,
          overrides: { claudeCodeSandbox: sandbox },
        });
      } catch (error) {
        recoveryCaptureError = error;
        logger.warn(`[claude-restart] continuation capture failed for ${currentSid}`, error);
      }

      // 占位 message：让用户在重启期间看到状态
      const enterOff = sandbox === 'off';
      const placeholderText = enterOff
        ? '⚠ 正在关闭 OS 沙盒，重启 SDK 中…'
        : `⚠ 正在切换 OS 沙盒档位到 ${sandbox}，重启 SDK 中…`;
      this.ctx.emit({
        sessionId: currentSid,
        agentId: AGENT_ID,
        kind: 'message',
        payload: { text: placeholderText },
        ts: Date.now(),
        source: 'sdk',
      });

      // REVIEW_36 R2 MED-B 修法：单飞标记必须在 closeSession + DB write + createSession **之前**
      // set，覆盖整个冷重启的副作用窗口。同 restartWithPermissionMode 修法。
      const p = (async (): Promise<string> => {
        await this.ctx.closeSession(currentSid, { markRecentlyDeleted: false });

        // 先写 DB：让 createSession resume 路径能从 sessionRepo 读到新 sandbox
        sessionRepo.setClaudeCodeSandbox(currentSid, sandbox);
        const updatedRec = sessionRepo.get(currentSid);
        if (updatedRec) eventBus.emit('session-upserted', updatedRec);

        try {
          // **plan restart-controller-jsonl-precheck-20260521 §Step 3e 修法** (与 Step 3d 同款):
          // jsonl 预检 + fallback (jsonl 缺失走 fresh-cli-reuse-app + helper 内部续历史摘要 +
          // emit fallback info + emit role='user';不变量 11 helper 已包办)。
          // fellBack=false（jsonl 在）时走正常 resume，**不**注入 DB 历史（CHANGELOG_223 撤回 221 注入）：
          // CLI `--resume` 已从 jsonl 续上完整上下文，仅 jsonl 缺失 fallback 才靠 maybeJsonlFallback 续历史。
          const fbResult = await maybeJsonlFallback(
            {
              jsonlExistsThunk: this.ctx.jsonlExistsThunk,
              jsonlMtimeMsThunk: this.ctx.jsonlMtimeMsThunk,
              createSession: this.ctx.createSession,
              prepareRecoveryContinuation: this.ctx.prepareRecoveryContinuation,
              emit: this.ctx.emit,
              latestConversationMessageTsThunk: this.ctx.latestConversationMessageTsThunk,
            },
            {
              sessionId: currentSid,
              cliSessionId: rec.cliSessionId ?? null, // SessionRecord.cliSessionId 是 optional (?: string | null) → ?? null 兜底
              cwd: rec.cwd,
              prompt: handoffPrompt,
              recoveryCapture,
              recoveryCaptureError,
              minHealJsonlMtimeMs: rec.lastEventAt,
              provider: rec.runtimeProvider ?? undefined,
              permissionMode: rec.permissionMode ?? undefined, // 透传保留用户辛苦切的 mode (不被 sandbox 切档静默重置)
              claudeCodeSandbox: sandbox, // 新 sandbox 档 (与下方 createSession 同款)
              extraAllowWrite: rec.extraAllowWrite ?? undefined,
              cwdFellBack: false,
              emitContext: 'restart',
              restartLabel: `OS 沙盒 ${sandbox}`, // discriminated union 'restart' 分支必填
            },
          );
          if (fbResult.fellBack) {
            return fbResult.finalSessionId; // == currentSid (不变量 3 applicationSid 全程不变)
          }

          await this.ctx.createSession({
            cwd: rec.cwd,
            prompt: handoffPrompt,
            resume: currentSid,
            provider: rec.runtimeProvider ?? undefined,
            // **plan reverse-rename-sid-stability-20260520 §C.1 R3 MED-R3-2 修订** (同 restartWithPermissionMode):
            // **CHANGELOG_224 幻影 fork 自愈**: healedCliSessionId 命中时切到它(= currentSid),
            // 防 rec.cliSessionId 那个幻影 id 让 CLI `--resume` hard-fail 退 fresh-cli。
            resumeCliSid: fbResult.healedCliSessionId ?? rec.cliSessionId ?? currentSid,
            claudeCodeSandbox: sandbox,
            // REVIEW_36 R2 MED-A 修法：必须透传 rec.permissionMode 否则新 SDK 默认 'default'，
            // DB 仍保留旧 mode（acceptEdits/plan/bypassPermissions）→ DB/UI 与 SDK 实际行为不一致。
            // 与 restartWithPermissionMode 透传 mode 同款理由（用户辛苦切的 mode 不能被 sandbox 切档静默重置）。
            permissionMode: rec.permissionMode ?? undefined,
            // plan cross-adapter-parity-20260515 + REVIEW_41 MED-3 fix:rec.extraAllowWrite 必须
            // 透传,否则切 OS sandbox 档冷重启后 SDK 子进程 sandbox.allowWrite 不含原 mainRepo
            // (与 restartWithPermissionMode 同款治法)。
            extraAllowWrite: rec.extraAllowWrite ?? undefined,
          });
          // **plan reverse-rename-sid-stability-20260520 §C.1 反向 rename 修订** (同 restartWithPermissionMode):
          // handle.sessionId === currentSid (applicationSid 不变);CLI 真实 fork 由 stream-processor S6
          // fork detect 内部走 sessionManager.updateCliSessionId 黑名单链处理。
          return currentSid;
        } catch (err) {
          // 回滚：DB 改回 oldSandbox + emit upsert + emit error message
          sessionRepo.setClaudeCodeSandbox(currentSid, oldSandbox);
          const rolled = sessionRepo.get(currentSid);
          if (rolled) eventBus.emit('session-upserted', rolled);
          this.ctx.emit({
            sessionId: currentSid,
            agentId: AGENT_ID,
            kind: 'message',
            payload: {
              text:
                `⚠ 切到 sandbox ${sandbox} 失败：${(err as Error)?.message ?? String(err)}。` +
                `档位已回退到 ${oldSandbox ?? '(全局默认)'}，请重新发送一条消息让 Claude 续上。`,
              error: true,
            },
            ts: Date.now(),
            source: 'sdk',
          });
          throw err;
        }
      })();
      this.ctx.recovering.set(currentSid, p);
      try {
        return await p;
      } finally {
        this.ctx.recovering.delete(currentSid);
      }
    } finally {
      if (recoveryCapture) {
        try {
          this.ctx.cleanupRecoveryContinuation(recoveryCapture);
        } catch (cleanupError) {
          logger.warn(
            `[claude-restart] continuation cleanup failed for ${currentSid}`,
            cleanupError,
          );
        }
      }
      // Phase R3 fix-1: 注销 rename listener 防 leak (与 restartWithPermissionMode 同款)
      eventBus.off('session-renamed', renameListener);
    }
  }
}
