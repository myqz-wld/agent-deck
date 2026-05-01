/**
 * Permission / AskUserQuestion / ExitPlanMode 响应 + 超时管理（CHANGELOG_52 Step 3b）。
 *
 * 抽自 ClaudeSdkBridge 6 个 respond/list 方法 + 3 个 private timeout 方法。
 * 所有方法的 class state 通过 ResponderCtx 注入（sessions Map / emit / 超时阈值）；
 * respondExitPlanMode 内部 cold-switch 路径调 lifecycle.restartWithPermissionMode 改走
 * restartThunk（F1 修法：原 plan 漏了这条循环依赖；本步 sdk-bridge.ts 内仍用临时 wrapper
 * 兜中间态 typecheck，3f 拆 lifecycle 时 ctor 改接 restartThunk）。
 *
 * 护栏（不变）：
 * - REVIEW_11 Bug 3 — approve+plan 走 deny+message 不调 setPermissionMode（plan 分支不动 SDK 也不写 DB）
 * - REVIEW_13 Bug 6 / CHANGELOG_34 — approve-bypass 走 deny+interrupt:true 中止 OLD turn 前先 expectedClose=true
 * - 超时机制 — permissionTimeoutMs > 0 时按超时 deny+interrupt 处理（permission），keep-planning（exit-plan）
 */
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type {
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  PermissionRequest,
  PermissionResponse,
} from '@shared/types';
import { sessionRepo } from '@main/store/session-repo';
import { eventBus } from '@main/event-bus';
import { AGENT_ID } from './constants';
import type { InternalSession, SdkBridgeOptions } from './types';

export interface ResponderCtx {
  /** 共享 sessions Map ref（facade 持有，sub-class 仅读写不重新赋值） */
  readonly sessions: Map<string, InternalSession>;
  /** 共享 emit 函数（来自 SdkBridgeOptions.emit） */
  readonly emit: SdkBridgeOptions['emit'];
  /** 实时取超时阈值（用 getter 让运行时 setPermissionTimeoutMs 改了也能拿到新值） */
  readonly getPermissionTimeoutMs: () => number;
}

/** 冷切到 bypass 的 thunk：avoid responder → lifecycle 循环依赖（F1 修法） */
type RestartThunk = (
  sessionId: string,
  mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions',
  handoffPrompt: string,
) => Promise<string>;

export class PermissionResponder {
  constructor(
    private readonly ctx: ResponderCtx,
    private readonly restartThunk: RestartThunk,
  ) {}

  /**
   * 用户对一次工具调用的允许/拒绝。如果会话不存在或 requestId 已被处理，静默忽略。
   */
  respondPermission(sessionId: string, requestId: string, response: PermissionResponse): void {
    const s = this.ctx.sessions.get(sessionId);
    if (!s) return;
    const entry = s.pendingPermissions.get(requestId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    s.pendingPermissions.delete(requestId);
    if (response.decision === 'allow') {
      entry.resolver({
        behavior: 'allow',
        updatedInput: (response.updatedInput ?? {}) as Record<string, unknown>,
        updatedPermissions: response.updatedPermissions as PermissionResult extends {
          updatedPermissions?: infer U;
        }
          ? U
          : never,
      });
    } else {
      entry.resolver({
        behavior: 'deny',
        message: response.message ?? '用户拒绝',
        interrupt: false,
      });
    }
  }

  /** 用户提交 AskUserQuestion 的答案，把它喂回给 SDK。 */
  respondAskUserQuestion(
    sessionId: string,
    requestId: string,
    answer: AskUserQuestionAnswer,
  ): void {
    const s = this.ctx.sessions.get(sessionId);
    if (!s) return;
    const entry = s.pendingAskUserQuestions.get(requestId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    s.pendingAskUserQuestions.delete(requestId);
    entry.resolver(answer);
  }

  /**
   * 用户对 ExitPlanMode 的决策（批准 / 继续规划），驱动 SDK allow / deny。
   *
   * 4 档目标 mode 分两类处理：
   * - approve + targetMode ∈ {default, acceptEdits, plan}：热切。resolver 走 allow，settle 后
   *   同步调 `query.setPermissionMode(targetMode)` + 写 DB + emit upsert，下次工具调用按新 mode。
   * - approve-bypass：冷切。resolver 走 deny + interrupt:true 中止 OLD turn，外层调
   *   `restartThunk` 把 plan 文本作 handoff prompt 重启 SDK 子进程到 bypass，
   *   规避「allow 后 SDK 推 tool_use 与重启子进程抢 jsonl flush」race。
   * - keep-planning：deny + 用户反馈，Claude 留在 plan mode 修计划。
   */
  async respondExitPlanMode(
    sessionId: string,
    requestId: string,
    response: ExitPlanModeResponse,
  ): Promise<void> {
    const s = this.ctx.sessions.get(sessionId);
    if (!s) return;
    const entry = s.pendingExitPlanModes.get(requestId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    s.pendingExitPlanModes.delete(requestId);
    // 冷切档先打 expectedClose：resolver 即将返回 deny+interrupt:true 让 SDK 强制中止
    // OLD turn，会触发 SDK 内部 [ede_diagnostic] 状态机不一致诊断错误（result_type=user
    // + stop_reason=tool_use 不匹配）。flag 让 consume() catch 块认出这是设计内的副产品，
    // 不弹「⚠ SDK 流中断」红字 message。后续 restartWithPermissionMode → closeSession
    // 还会再打一次（双保险，覆盖所有应用主动关闭的入口）。
    if (response.decision === 'approve-bypass') {
      s.expectedClose = true;
    }
    // 先驱动 SDK：approve→allow / approve-bypass→deny+interrupt / keep-planning→deny
    entry.resolver(response);

    if (response.decision === 'approve') {
      // REVIEW_11 Bug 3：approve+plan 走 deny+message 让 CLI 留在 plan，绝不能再调
      // setPermissionMode('plan')（CLI 当前已经在 plan，调了等于 no-op；更危险的是
      // 走 setPermissionMode 路径会触发 SDK 内部 mode 重置 race，反而把档抖回 default）。
      // 仅 approve + targetMode ∈ {default, acceptEdits} 才走热切；plan 分支不动 SDK 也不写 DB
      // （DB 已是 plan，SDK 也仍在 plan）。
      if (response.targetMode === 'plan') {
        return;
      }
      // 热切档：SDK 已退出 plan mode，立刻同步 mode 到 SDK Query + DB + UI
      try {
        await s.query.setPermissionMode(response.targetMode);
        sessionRepo.setPermissionMode(sessionId, response.targetMode);
        const updated = sessionRepo.get(sessionId);
        if (updated) eventBus.emit('session-upserted', updated);
      } catch (err) {
        console.warn(
          `[sdk-bridge] hot-switch permission mode after approve failed: ${sessionId}`,
          err,
        );
      }
      return;
    }

    if (response.decision === 'approve-bypass') {
      // 冷切档：resolver 已 deny + interrupt OLD turn；现在重启子进程到 bypass，
      // 把 plan 文本作 handoff 让 Claude 重新执行（无需再调 ExitPlanMode）
      const handoffPrompt =
        `用户已批准以下 plan 并切换到完全免询问模式（bypassPermissions），` +
        `请直接按 plan 执行（无需再次调用 ExitPlanMode 确认）：\n\n` +
        entry.payload.plan;
      try {
        await this.restartThunk(sessionId, 'bypassPermissions', handoffPrompt);
      } catch (err) {
        // restartThunk 内部已 emit error message + 回滚 DB，这里只 log
        console.error(
          `[sdk-bridge] cold-switch to bypass after approve failed: ${sessionId}`,
          err,
        );
      }
    }
    // keep-planning：什么都不用做，resolver 已 deny + Claude 留在 plan mode
  }

  /**
   * 当前会话还在 pending 的请求快照。renderer HMR / 重启 / 切会话时，
   * store 的 pendingPermissionsBySession 是空的，但主进程这边可能还挂着等用户的请求 ——
   * 让 renderer 主动拉一次重建 UI，避免渲染成「已处理」按钮不显示、用户点不动死锁。
   */
  listPending(sessionId: string): {
    permissions: PermissionRequest[];
    askQuestions: AskUserQuestionRequest[];
    exitPlanModes: ExitPlanModeRequest[];
  } {
    const s = this.ctx.sessions.get(sessionId);
    if (!s) return { permissions: [], askQuestions: [], exitPlanModes: [] };
    return {
      permissions: [...s.pendingPermissions.values()].map((e) => e.payload),
      askQuestions: [...s.pendingAskUserQuestions.values()].map((e) => e.payload),
      exitPlanModes: [...s.pendingExitPlanModes.values()].map((e) => e.payload),
    };
  }

  /** 全量快照：renderer 启动时一次性灌进 store。 */
  listAllPending(): Record<
    string,
    {
      permissions: PermissionRequest[];
      askQuestions: AskUserQuestionRequest[];
      exitPlanModes: ExitPlanModeRequest[];
    }
  > {
    const out: Record<
      string,
      {
        permissions: PermissionRequest[];
        askQuestions: AskUserQuestionRequest[];
        exitPlanModes: ExitPlanModeRequest[];
      }
    > = {};
    for (const [sid, s] of this.ctx.sessions) {
      if (
        s.pendingPermissions.size === 0 &&
        s.pendingAskUserQuestions.size === 0 &&
        s.pendingExitPlanModes.size === 0
      ) {
        continue;
      }
      out[sid] = {
        permissions: [...s.pendingPermissions.values()].map((e) => e.payload),
        askQuestions: [...s.pendingAskUserQuestions.values()].map((e) => e.payload),
        exitPlanModes: [...s.pendingExitPlanModes.values()].map((e) => e.payload),
      };
    }
    return out;
  }

  /** 超时触发：把权限请求当成 deny+interrupt 处理，等同于用户拒绝并打断当前 turn。 */
  timeoutPermission(sessionId: string, requestId: string): void {
    const s = this.ctx.sessions.get(sessionId);
    if (!s) return;
    const entry = s.pendingPermissions.get(requestId);
    if (!entry) return;
    s.pendingPermissions.delete(requestId);
    // 不需要 clearTimeout：本次回调就是这个 timer 触发的
    this.ctx.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'waiting-for-user',
      payload: { type: 'permission-cancelled', requestId },
      ts: Date.now(),
      source: 'sdk',
    });
    this.ctx.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: {
        text:
          `⚠ 权限请求 ${entry.payload.toolName ?? ''} 等待 ${Math.round(
            this.ctx.getPermissionTimeoutMs() / 1000,
          )} 秒未响应，` + `已自动按「拒绝」处理并中断当前 turn。`,
        error: true,
      },
      ts: Date.now(),
      source: 'sdk',
    });
    entry.resolver({ behavior: 'deny', message: 'timeout', interrupt: true });
  }

  /** 超时触发：AskUserQuestion 与权限请求处理类似，但 interrupt:false 让 SDK 把它当成空答案。 */
  timeoutAskUserQuestion(sessionId: string, requestId: string): void {
    const s = this.ctx.sessions.get(sessionId);
    if (!s) return;
    const entry = s.pendingAskUserQuestions.get(requestId);
    if (!entry) return;
    s.pendingAskUserQuestions.delete(requestId);
    this.ctx.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'waiting-for-user',
      payload: { type: 'ask-question-cancelled', requestId },
      ts: Date.now(),
      source: 'sdk',
    });
    this.ctx.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: {
        text:
          `⚠ Claude 的提问等待 ${Math.round(
            this.ctx.getPermissionTimeoutMs() / 1000,
          )} 秒未答复，已自动跳过。`,
        error: true,
      },
      ts: Date.now(),
      source: 'sdk',
    });
    entry.resolver({
      answers: [{ question: '__timeout__', selected: [], other: '用户超时未回答' }],
    });
  }

  /** 超时触发：ExitPlanMode 按「继续规划 + 默认反馈」处理，让 Claude 留在 plan mode 不打断 turn。 */
  timeoutExitPlanMode(sessionId: string, requestId: string): void {
    const s = this.ctx.sessions.get(sessionId);
    if (!s) return;
    const entry = s.pendingExitPlanModes.get(requestId);
    if (!entry) return;
    s.pendingExitPlanModes.delete(requestId);
    this.ctx.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'waiting-for-user',
      payload: { type: 'exit-plan-cancelled', requestId },
      ts: Date.now(),
      source: 'sdk',
    });
    this.ctx.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'message',
      payload: {
        text:
          `⚠ ExitPlanMode 等待 ${Math.round(
            this.ctx.getPermissionTimeoutMs() / 1000,
          )} 秒未响应，` + `已自动按「继续规划」处理，Claude 留在 plan mode 等待下一步指示。`,
        error: true,
      },
      ts: Date.now(),
      source: 'sdk',
    });
    entry.resolver({ decision: 'keep-planning', feedback: '用户超时未响应' });
  }
}
