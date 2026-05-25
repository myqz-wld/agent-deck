/**
 * codex sdk-bridge 冷切 sandbox 控制器（R37 P2-E Step 3.4c）。
 *
 * 抽自 CodexSdkBridge.restartWithCodexSandbox（CHANGELOG_<X> A2b）。
 * 与 claude `restart-controller.ts` (RestartController) 同模式：
 * - 通过 `RestartCtx` 注入 facade 共享 ref（recovering Map + emit + thunk closeSession + thunk createSession）
 * - 不持 sessions Map：close + createSession 已隐含管理 internal state
 * - sub-class 持 ctx 不直接持 facade，避免循环引用
 *
 * 与 claude RestartController 差异：
 * - codex 没有 `restartWithPermissionMode`（codex 不支持 permission mode 概念）
 * - 仅 `restartWithCodexSandbox` 一个方法（与 claude `restartWithClaudeCodeSandbox` 字面镜像）
 * - symmetry-plan P2 HIGH-A：加 `recovering` Map 单飞保护（与 claude 同款 REVIEW_36 R2 MED-B）
 *
 * 行为变化（symmetry-plan P2 HIGH-A + MED-A）：
 * - 加 recovering Map 单飞排队执行（修前并发 restartWithCodexSandbox 可双 SDK 子进程同 sid）
 * - DB write/rollback 后 emit `session-upserted` 让 SessionDetail 下拉值立即跟到新 mode
 *   （与 claude 同款，5-10s busy 期间用户已经看到「切完了」）
 */
import type { AgentEvent } from '@shared/types';
import { sessionRepo } from '@main/store/session-repo';
import { eventBus } from '@main/event-bus';
import { AGENT_ID } from './constants';
import type { CodexSessionHandle } from './types';

export interface RestartCreateOpts {
  cwd: string;
  prompt: string;
  resume?: string;
  /**
   * **plan reverse-rename-sid-stability-20260520 §C.2 R3 MED-R3-2 修订**:
   * 反向 rename 后 createSession opts.resume 是 applicationSid;codex SDK resumeThread 的 thread_id
   * 字段需要 cli sid (= rec.cliSessionId)。caller 显式传 resumeCliSid 兜底。
   */
  resumeCliSid?: string;
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
}

export interface RestartCtx {
  /**
   * symmetry-plan P2 HIGH-A：与 claude `RestartCtx.recovering` 同模式 — 与 facade 共享的
   * 单飞 Map（facade 持权威 ref，restart-controller mutate 同一份）。同 sessionId 的并发
   * `restartWithCodexSandbox` 排队执行。未来 HIGH-B codex recoverer 也共享本 Map。
   */
  recovering: Map<string, Promise<unknown>>;
  emit: (event: AgentEvent) => void;
  /** thunk 反调 facade.closeSession，避免直接持有 facade ref（与 claude RestartCtx 同模式）。 */
  closeSession: (sessionId: string) => Promise<void>;
  /** thunk 反调 facade.createSession，restart 路径用 resume + 新 sandbox 重建。 */
  createSession: (opts: RestartCreateOpts) => Promise<CodexSessionHandle>;
}

export class RestartController {
  constructor(private ctx: RestartCtx) {}

  /**
   * 冷切 codex sandbox 档位（CHANGELOG_<X> A2b）：销毁旧 thread + 用新 sandbox resume 重建。
   *
   * 与 claude restartWithClaudeCodeSandbox 同模式：
   * - 单飞：等同 sessionId 的 in-flight recovery / restart 完成（symmetry-plan P2 HIGH-A）
   * - emit 占位 message → close OLD → 写 DB → emit session-upserted → createSession({resume, codexSandbox, prompt})
   * - 失败回滚 sessionRepo.codexSandbox + emit session-upserted 让下拉回弹 + emit error message
   *
   * codex SDK sandboxMode 是 startThread/resumeThread spawn-time 锁定，无法运行时热切；
   * 必须冷切（销毁旧 thread + 重建）。spike-A2 实测确认 resumeThread 透传新 sandbox 真生效。
   *
   * @returns 重启后的 sessionId（codex resume 不会隐式 fork，理论上等于入参 sid，
   *   但接口签名与 claude 对齐保留 string 返回）
   */
  async restartWithCodexSandbox(
    sessionId: string,
    sandbox: 'workspace-write' | 'read-only' | 'danger-full-access',
    handoffPrompt: string,
  ): Promise<string> {
    if (!handoffPrompt.trim()) {
      throw new Error(
        'restartWithCodexSandbox 要求 handoffPrompt 非空（codex SDK runStreamed 协议约束，' +
          'resume 路径必须有 prompt 触发首条 turn）',
      );
    }

    // symmetry-plan P2 HIGH-A：单飞 — 等同 sessionId 的 in-flight restart 完成
    // （与 claude restart-controller REVIEW_36 R2 MED-B 修法同款）。先等再起,避免并发
    // restart 同时进 close → DB write → createSession 阶段交错。
    //
    // **REVIEW_56 MED-1 修法**(与 claude restart-controller.ts:153-163 同款 while 循环):
    // 修前 单 if 仅 wait 一次 → 3 并发 waiter race(A inflight 中 B/C 都 await A;A done 后
    // B/C **同时**进入下面 close → DB → createSession 阶段,既越过单飞又重复执行)。修后
    // while 循环 re-check `recovering Map`,若期间 B 已注册新 inflight,C 继续等。
    // codex 这边不需 listener transfer Map entry(claude 那边因 SDK 软 fork rename + Map
    // key 切换才需要 transfer;codex spike-A2 实测 codex resume 不 fork,sessionId 全程稳定)。
    let inflight = this.ctx.recovering.get(sessionId);
    while (inflight) {
      try {
        await inflight;
      } catch {
        // 上一个 restart 失败不影响本次重启尝试
      }
      inflight = this.ctx.recovering.get(sessionId);
    }

    const rec = sessionRepo.get(sessionId);
    if (!rec) throw new Error(`session ${sessionId} not found in repo`);
    const oldSandbox: 'workspace-write' | 'read-only' | 'danger-full-access' | null =
      rec.codexSandbox ?? null;

    // 占位 message：让用户在 close + 重建 期间看到状态（与 claude 冷切同模式）
    this.ctx.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: {
        text: `⚠ 正在切换 Codex sandbox 到 ${sandbox}，重启 thread 中…`,
      },
      ts: Date.now(),
      source: 'sdk',
    });

    // symmetry-plan P2 HIGH-A：单飞标记必须在 closeSession + DB write + createSession **之前**
    // set，覆盖整个冷重启的副作用窗口（与 claude REVIEW_36 R2 MED-B 修法同款）。原实现
    // 直接顺序跑 close → DB → createSession，两个并发 restart 都能越过 inflight 检查同时进入。
    const p = (async (): Promise<string> => {
      // close OLD：内部 intentionallyClosed=true → abort current turn → runTurnLoop 静默退出
      await this.ctx.closeSession(sessionId);

      // 先写 DB：让 createSession resume 路径能从 sessionRepo 读到新 sandbox。
      // symmetry-plan P2 MED-A：写库后 emit session-upserted 让 SessionDetail 下拉值立即跟到
      // 新 mode（与 claude 同款，5-10s busy 期间用户已经看到「切完了」）。
      sessionRepo.setCodexSandbox(sessionId, sandbox);
      const updatedRec = sessionRepo.get(sessionId);
      if (updatedRec) eventBus.emit('session-upserted', updatedRec);

      try {
        const handle = await this.ctx.createSession({
          cwd: rec.cwd,
          prompt: handoffPrompt,
          resume: sessionId,
          // **plan reverse-rename-sid-stability-20260520 §C.2 R3 MED-R3-2 修订**:
          // 显式传 cli sid 让 codex SDK resumeThread 拿正确 thread_id (反向 rename 后两者不同时)。
          resumeCliSid: rec.cliSessionId ?? sessionId,
          codexSandbox: sandbox,
        });
        // **plan reverse-rename-sid-stability-20260520 §C.2 反向 rename 修订**:
        // codex resume 路径下 applicationSid 全程不变 = sessionId;
        // CLI 真实 fork (case 3) 由 thread-loop 内部走 sessionManager.updateCliSessionId 黑名单链
        // (与 §A.4-pre S6 同款),不再调 sessionManager.renameSdkSession。
        // codex-tests-plan P3 LOW (REVIEW_40 R2 reviewer-codex):原 post-rename 防御 block 已删
        // (commit 6e0eb37 / REVIEW_40 注释);thread-loop case 3 是 SSOT。
        return handle.sessionId;
      } catch (err) {
        // 回滚：DB 改回 oldSandbox + emit session-upserted 让下拉回弹 + emit error message
        sessionRepo.setCodexSandbox(sessionId, oldSandbox);
        const rolled = sessionRepo.get(sessionId);
        if (rolled) eventBus.emit('session-upserted', rolled);
        this.ctx.emit({
          sessionId,
          agentId: AGENT_ID,
          kind: 'message',
          payload: {
            text:
              `⚠ 切到 sandbox ${sandbox} 失败：${(err as Error)?.message ?? String(err)}。` +
              `档位已回退到 ${oldSandbox ?? '(默认)'}，请重新发送一条消息让 Codex 续上。`,
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
