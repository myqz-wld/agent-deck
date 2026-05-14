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
    const inflight = this.ctx.recovering.get(sessionId);
    if (inflight) {
      try {
        await inflight;
      } catch {
        // 上一个 recovery 失败不影响本次重启尝试
      }
    }

    const rec = sessionRepo.get(sessionId);
    if (!rec) throw new Error(`session ${sessionId} not found in repo`);
    const oldMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' =
      rec.permissionMode ?? 'default';

    // 占位 message：分方向文案，让用户在 5-10s busy 期间看到状态
    const enterBypass = mode === 'bypassPermissions';
    const placeholderText = enterBypass
      ? '⚠ 正在切换到完全免询问模式（bypass），重启 SDK 中…'
      : `⚠ 正在切换权限模式到 ${mode}，重启 SDK 中…`;
    this.ctx.emit({
      sessionId,
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
      await this.ctx.closeSession(sessionId);

      // 写 DB：必须先于 createSession（cold path 翻序；hot path 不动保持 ipc.ts:451-462 原样）。
      // 同步 emit upsert 让 SessionDetail 下拉值立即跟到新 mode（5-10s busy 期间用户已经看到「切完了」）。
      sessionRepo.setPermissionMode(sessionId, mode);
      const updatedRec = sessionRepo.get(sessionId);
      if (updatedRec) eventBus.emit('session-upserted', updatedRec);

      try {
        const handle = await this.ctx.createSession({
          cwd: rec.cwd,
          prompt: handoffPrompt,
          resume: sessionId,
          permissionMode: mode,
        });
        const newRealId = handle.sessionId;
        // CLI 隐式 fork：拿到的 newRealId 可能 ≠ OLD sessionId（CLI 在 streaming + resume 下行为不可控，
        // 见 CLAUDE.md「会话恢复 / 断连 UX」节）。rename 把 DB 子表 + sdkOwned 整体迁到 NEW 名下。
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
        // 回滚：DB 改回 oldMode + emit upsert 让下拉回弹
        sessionRepo.setPermissionMode(sessionId, oldMode);
        const rolled = sessionRepo.get(sessionId);
        if (rolled) eventBus.emit('session-upserted', rolled);
        // 占位 message 已 emit 过，再 emit 一条 error 让用户知道失败 + 已回退
        this.ctx.emit({
          sessionId,
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
    this.ctx.recovering.set(sessionId, p);
    try {
      return await p;
    } finally {
      this.ctx.recovering.delete(sessionId);
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
    const inflight = this.ctx.recovering.get(sessionId);
    if (inflight) {
      try {
        await inflight;
      } catch {
        // 上一个失败不影响本次
      }
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
