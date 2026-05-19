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
import type { AgentEvent } from '@shared/types';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { eventBus } from '@main/event-bus';
import { AGENT_ID } from './constants';
import type { SdkSessionHandle } from './types';

export interface RestartCreateOpts {
  cwd: string;
  prompt: string;
  resume?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict';
  /**
   * plan cross-adapter-parity-20260515 Phase A + REVIEW_41 MED-3 fix: cold-restart 路径
   * (restartWithPermissionMode / restartWithClaudeCodeSandbox)透传 extra writable roots。
   * 修前 restart-controller 调 createSession 时不带 extraAllowWrite → 用户在 detail 切
   * acceptEdits/bypass / 切 OS sandbox 档冷重启后 SDK 子进程 sandbox.allowWrite 不含原
   * mainRepo → 写 plan 文件静默失败(与 plan 主旨 app 重启同款 bug,触发条件不同)。
   */
  extraAllowWrite?: readonly string[];
}

export interface RestartCtx {
  /**
   * 与 facade 共享的单飞 Map（CHANGELOG_52 Step 3d/F2 修法：facade 持权威 ref，
   * recoverer 与 restart-controller 双方 mutate 同一份）。同 sessionId 的并发
   * recoverAndSend / restartWithX 排队执行。
   */
  recovering: Map<string, Promise<unknown>>;
  emit: (event: AgentEvent) => void;
  /** thunk 反调 facade.closeSession，避免直接持有 facade ref */
  closeSession: (sessionId: string) => Promise<void>;
  /** thunk 反调 facade.createSession，restart 路径用 resume + 新 mode/sandbox 重建 */
  createSession: (opts: RestartCreateOpts) => Promise<SdkSessionHandle>;
}

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
   * - 调用方负责拼好语义（例如「用户已批准 plan…请直接执行」/「继续之前的会话」）。
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
    let currentSid = sessionId;
    const renameListener = (payload: { from: string; to: string }): void => {
      if (payload.from === currentSid) currentSid = payload.to;
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
        await this.ctx.closeSession(currentSid);

        // 写 DB：必须先于 createSession（cold path 翻序；hot path 不动保持 ipc.ts:451-462 原样）。
        // 同步 emit upsert 让 SessionDetail 下拉值立即跟到新 mode（5-10s busy 期间用户已经看到「切完了」）。
        sessionRepo.setPermissionMode(currentSid, mode);
        const updatedRec = sessionRepo.get(currentSid);
        if (updatedRec) eventBus.emit('session-upserted', updatedRec);

        try {
          const handle = await this.ctx.createSession({
            cwd: rec.cwd,
            prompt: handoffPrompt,
            resume: currentSid,
            permissionMode: mode,
            // plan cross-adapter-parity-20260515 + REVIEW_41 MED-3 fix:rec.claudeCodeSandbox /
            // rec.extraAllowWrite 必须透传,否则冷重启后 SDK 子进程 sandbox.allowWrite 丢失原
            // 用户透传的 mainRepo (典型 hand_off_session 外置 worktree caller 传 [mainRepo] 让
            // session 能写 mainRepo plan 文件)。与 createSession opts.claudeCodeSandbox /
            // recoverer fallback 路径同款显式透传 + ?? undefined 兜底。
            claudeCodeSandbox: rec.claudeCodeSandbox ?? undefined,
            extraAllowWrite: rec.extraAllowWrite ?? undefined,
          });
          const newRealId = handle.sessionId;
          // CLI 隐式 fork：拿到的 newRealId 可能 ≠ OLD sessionId（CLI 在 streaming + resume 下行为不可控，
          // 见 CLAUDE.md「会话恢复 / 断连 UX」节）。rename 把 DB 子表 + sdkOwned 整体迁到 NEW 名下。
          if (newRealId !== currentSid) {
            try {
              sessionManager.renameSdkSession(currentSid, newRealId);
            } catch (renameErr) {
              console.error(
                `[sdk-bridge] post-restart rename failed ${currentSid} → ${newRealId}, ` +
                  `NEW session works but app-side history not migrated.`,
                renameErr,
              );
            }
          }
          return newRealId;
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
      // Phase 2.9: 注销 rename listener 防 leak (event-bus 长生命周期，listener 不清会持续监听)
      eventBus.off('session-renamed', renameListener);
    }
  }

  /**
   * 冷切 OS 沙盒（CHANGELOG_74）：与 restartWithPermissionMode 字面镜像。
   * 销毁旧 SDK 子进程 + 用新 sandbox 档位 createSession resume 重建。
   *
   * 为什么必须冷切？
   * - SDK 的 sandbox options 是 query() spawn-time 锁定（与 codex sandbox 同模式），
   *   运行时无法热切。重启子进程 + 在 createSession 内重新拼 buildSandboxOptions 才生效。
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
    let inflight = this.ctx.recovering.get(sessionId);
    while (inflight) {
      try {
        await inflight;
      } catch {
        // 上一个失败不影响本次
      }
      inflight = this.ctx.recovering.get(sessionId);
    }

    const rec = sessionRepo.get(sessionId);
    if (!rec) throw new Error(`session ${sessionId} not found in repo`);
    const oldSandbox: 'off' | 'workspace-write' | 'strict' | null =
      rec.claudeCodeSandbox ?? null;

    // 占位 message：让用户在重启期间看到状态
    const enterOff = sandbox === 'off';
    const placeholderText = enterOff
      ? '⚠ 正在关闭 OS 沙盒，重启 SDK 中…'
      : `⚠ 正在切换 OS 沙盒档位到 ${sandbox}，重启 SDK 中…`;
    this.ctx.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: { text: placeholderText },
      ts: Date.now(),
      source: 'sdk',
    });

    // REVIEW_36 R2 MED-B 修法：单飞标记必须在 closeSession + DB write + createSession **之前**
    // set，覆盖整个冷重启的副作用窗口。同 restartWithPermissionMode 修法。
    const p = (async (): Promise<string> => {
      await this.ctx.closeSession(sessionId);

      // 先写 DB：让 createSession resume 路径能从 sessionRepo 读到新 sandbox
      sessionRepo.setClaudeCodeSandbox(sessionId, sandbox);
      const updatedRec = sessionRepo.get(sessionId);
      if (updatedRec) eventBus.emit('session-upserted', updatedRec);

      try {
        const handle = await this.ctx.createSession({
          cwd: rec.cwd,
          prompt: handoffPrompt,
          resume: sessionId,
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
        const newRealId = handle.sessionId;
        if (newRealId !== sessionId) {
          try {
            sessionManager.renameSdkSession(sessionId, newRealId);
          } catch (renameErr) {
            console.error(
              `[sdk-bridge] post-restart rename failed ${sessionId} → ${newRealId}, ` +
                `NEW session works but app-side history not migrated.`,
              renameErr,
            );
          }
        }
        return newRealId;
      } catch (err) {
        // 回滚：DB 改回 oldSandbox + emit upsert + emit error message
        sessionRepo.setClaudeCodeSandbox(sessionId, oldSandbox);
        const rolled = sessionRepo.get(sessionId);
        if (rolled) eventBus.emit('session-upserted', rolled);
        this.ctx.emit({
          sessionId,
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
    this.ctx.recovering.set(sessionId, p);
    try {
      return await p;
    } finally {
      this.ctx.recovering.delete(sessionId);
    }
  }
}
