/**
 * codex sdk-bridge 冷切 sandbox 控制器（R37 P2-E Step 3.4c）。
 *
 * 抽自 CodexSdkBridge.restartWithCodexSandbox（CHANGELOG_<X> A2b）。
 * 与 claude `restart-controller.ts` (RestartController) 同模式：
 * - 通过 `RestartCtx` 注入 facade 共享 ref（emit + thunk closeSession + thunk createSession）
 * - 不持 sessions Map：close + createSession 已隐含管理 internal state
 * - sub-class 持 ctx 不直接持 facade，避免循环引用
 *
 * 与 claude RestartController 差异：
 * - codex 没有 `recovering` Map（codex 没有断连自愈 / 隐式 fork 风险，单飞由 facade 调用方负责）
 * - codex 没有 `restartWithPermissionMode`（codex 不支持 permission mode 概念）
 * - 仅 `restartWithCodexSandbox` 一个方法（与 claude `restartWithClaudeCodeSandbox` 字面镜像）
 *
 * 行为零变化：抽出前后 emit / close / DB write / createSession resume / rename 防御 / 回滚序列字面一致。
 */
import type { AgentEvent } from '@shared/types';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { AGENT_ID } from './constants';
import type { CodexSessionHandle } from './types';

export interface RestartCreateOpts {
  cwd: string;
  prompt: string;
  resume?: string;
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
}

export interface RestartCtx {
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
   * 与 claude restartWithPermissionMode 同模式：
   * - emit 占位 message → close OLD → 写 DB → createSession({resume, codexSandbox, prompt})
   * - 失败回滚 sessionRepo.codexSandbox + emit error message
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

    // close OLD：内部 intentionallyClosed=true → abort current turn → runTurnLoop 静默退出
    await this.ctx.closeSession(sessionId);

    // 先写 DB：让 createSession resume 路径能从 sessionRepo 读到新 sandbox
    sessionRepo.setCodexSandbox(sessionId, sandbox);

    try {
      const handle = await this.ctx.createSession({
        cwd: rec.cwd,
        prompt: handoffPrompt,
        resume: sessionId,
        codexSandbox: sandbox,
      });
      // REVIEW_36 R2 codex follow-up：加 runtime defense 防 codex SDK 未来某版本让 resume 返回新 thread id
      // (与 claude SDK 隐式 fork 同款风险)。当前 codex SDK 实测 resumeThread 永远返回同 id（spike-A2 验证），
      // 但代码 thread-loop 仍走 `if (!internal.threadId)` 检测 thread.started.thread_id（即新 id 会被忽略）。
      // 加 rename 防御让此前提失效时（SDK 升级 / 行为变更）能整体迁移 app-side history 到 NEW_ID 名下，
      // 与 claude restartWithClaudeCodeSandbox / restartWithPermissionMode 同款保护。
      const newRealId = handle.sessionId;
      if (newRealId !== sessionId) {
        console.warn(
          `[codex-bridge] restartWithCodexSandbox: codex SDK returned different sessionId ${sessionId} → ${newRealId}; ` +
            `this is unexpected (codex resume historically returns same id). Carrying app-side history to NEW_ID via renameSdkSession.`,
        );
        try {
          sessionManager.renameSdkSession(sessionId, newRealId);
        } catch (renameErr) {
          console.error(
            `[codex-bridge] post-restart rename failed ${sessionId} → ${newRealId}, ` +
              `NEW session works but app-side history not migrated.`,
            renameErr,
          );
        }
      }
      return newRealId;
    } catch (err) {
      // 回滚：DB 改回 oldSandbox + emit error message
      sessionRepo.setCodexSandbox(sessionId, oldSandbox);
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
  }
}
