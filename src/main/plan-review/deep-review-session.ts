import { randomUUID } from 'node:crypto';
import { adapterRegistry } from '@main/adapters/registry';
import {
  isAgentId,
  type AgentId,
} from '@main/adapters/options-builder';
import { eventBus } from '@main/event-bus';
import { spawnSessionHandler } from '@main/agent-deck-mcp/tools/handlers/spawn';
import type { SpawnSessionResult } from '@main/agent-deck-mcp/tools/schemas';
import { dispatchAdapterMessageWithHandOffRedirect } from '@main/ipc/adapters-message-dispatch';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import log from '@main/utils/logger';
import {
  isClaudeThinkingLevel,
  isCodexThinkingLevel,
} from '@shared/session-metadata';
import type { AgentEvent, ExitPlanModeRequest, ExitPlanModeResponse } from '@shared/types';
import {
  buildLatePlanDecisionPrompt,
  buildPlanReviewAutoFeedbackPrompt,
  buildPlanReviewForkPrompt,
} from './prompts';

const logger = log.scope('plan-review-session');
const AUTO_FEEDBACK_TIMEOUT_MS = 5 * 60_000;
const NATIVE_FORK_ERROR = '无法创建隔离的原生 fork。请等待当前会话到达安全边界后重试。';

export interface PlanReviewChildSession {
  sessionId: string;
  agentId: AgentId;
}

export interface PlanReviewSessionCoordinator {
  start(input: {
    sourceSessionId: string;
    request: ExitPlanModeRequest;
  }): Promise<PlanReviewChildSession>;
  ask(child: PlanReviewChildSession, question: string): Promise<void>;
  generateFeedback(input: {
    child: PlanReviewChildSession;
    request: ExitPlanModeRequest;
  }): Promise<string>;
  deliverLateDecision(input: {
    sourceSessionId: string;
    request: ExitPlanModeRequest;
    response: ExitPlanModeResponse;
  }): Promise<void>;
  close(child: PlanReviewChildSession): Promise<void>;
}

function parseSpawnResult(result: Awaited<ReturnType<typeof spawnSessionHandler>>): SpawnSessionResult {
  const text = result.content[0]?.text;
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch (error) {
    logger.warn('[plan-review] native fork returned invalid JSON', { text }, error);
    throw new Error(NATIVE_FORK_ERROR);
  }
  if (result.isError || typeof body.sessionId !== 'string') {
    const error = typeof body.error === 'string' ? body.error : 'The native plan-review fork failed.';
    const hint = typeof body.hint === 'string' ? body.hint : null;
    logger.warn('[plan-review] native fork failed', { error, hint });
    throw new Error(NATIVE_FORK_ERROR);
  }
  return body as unknown as SpawnSessionResult;
}

function inheritedThinking(
  agentId: AgentId,
  value: string | null | undefined,
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | undefined {
  if (agentId === 'codex-cli') return isCodexThinkingLevel(value) ? value : undefined;
  return isClaudeThinkingLevel(value) ? value : undefined;
}

function assistantText(event: AgentEvent): string | null {
  if (event.kind !== 'message') return null;
  const payload = event.payload as { role?: unknown; text?: unknown; error?: unknown } | null;
  return payload?.role === 'assistant' && typeof payload.text === 'string' && payload.error !== true
    ? payload.text.trim()
    : null;
}

function isMatchingUserMessage(event: AgentEvent, correlationId: string): boolean {
  if (event.kind !== 'message') return false;
  const payload = event.payload as { role?: unknown; turnCorrelationId?: unknown } | null;
  return payload?.role === 'user' &&
    payload.turnCorrelationId === correlationId;
}

export class DefaultPlanReviewSessionCoordinator implements PlanReviewSessionCoordinator {
  private readonly operationTails = new Map<string, Promise<void>>();
  private readonly operationAbortControllers = new Map<string, AbortController>();

  async start(input: {
    sourceSessionId: string;
    request: ExitPlanModeRequest;
  }): Promise<PlanReviewChildSession> {
    const source = sessionRepo.get(input.sourceSessionId);
    if (!source || !isAgentId(source.agentId)) {
      throw new Error('源会话不可用，无法创建隔离的原生 fork。');
    }
    const thinking = inheritedThinking(source.agentId, source.thinking);

    let result: Awaited<ReturnType<typeof spawnSessionHandler>>;
    try {
      result = await spawnSessionHandler({
        adapter: source.agentId,
        cwd: source.cwd,
        prompt: buildPlanReviewForkPrompt({
          requestId: input.request.requestId,
          plan: input.request.plan,
          ...(input.request.title ? { title: input.request.title } : {}),
        }),
        contextMode: 'fork',
        displayName: input.request.title
          ? `计划审阅 · ${input.request.title}`.slice(0, 80)
          : '计划深度审阅',
        ...(source.model ? { model: source.model } : {}),
        ...(thinking ? { thinking } : {}),
        ...(source.permissionMode ? { permissionMode: source.permissionMode } : {}),
        ...(source.codexSandbox ? { codexSandbox: source.codexSandbox } : {}),
        ...(source.claudeCodeSandbox ? { claudeCodeSandbox: source.claudeCodeSandbox } : {}),
        ...(source.extraAllowWrite?.length
          ? { extraAllowWrite: [...source.extraAllowWrite] }
          : {}),
      }, {
        caller: {
          callerSessionId: input.sourceSessionId,
          parentSessionId: input.sourceSessionId,
          transport: 'in-process',
        },
      }, {
        suppressLeadContext: true,
        codexRuntimeAccess: {
          networkAccessEnabled: source.networkAccessEnabled ?? undefined,
          additionalDirectories: source.additionalDirectories ?? undefined,
        },
      });
    } catch (error) {
      logger.warn('[plan-review] native fork threw before returning a result', error);
      throw new Error(NATIVE_FORK_ERROR);
    }
    const parsed = parseSpawnResult(result);
    if (!isAgentId(parsed.adapter)) {
      await sessionManager.close(parsed.sessionId).catch(() => undefined);
      throw new Error('审阅会话返回了不受支持的适配器，已安全关闭。');
    }
    return { sessionId: parsed.sessionId, agentId: parsed.adapter };
  }

  async ask(child: PlanReviewChildSession, question: string): Promise<void> {
    await this.runSerialized(child, async (signal) => {
      const adapter = adapterRegistry.get(child.agentId);
      if (!adapter?.enqueueMessage) {
        throw new Error('审阅会话当前无法接收问题。');
      }
      const correlationId = randomUUID();
      await this.runCorrelatedTurn({
        child,
        correlationId,
        requireOutput: false,
        signal,
        enqueue: () => adapter.enqueueMessage!(child.sessionId, question, [], {
          deferUserEventUntilTurnStart: true,
          turnCorrelationId: correlationId,
        }),
      });
    });
  }

  async generateFeedback(input: {
    child: PlanReviewChildSession;
    request: ExitPlanModeRequest;
  }): Promise<string> {
    return this.runSerialized(input.child, async (signal) => {
      const adapter = adapterRegistry.get(input.child.agentId);
      if (!adapter?.enqueueMessage) {
        throw new Error('审阅会话当前无法生成计划意见。');
      }
      const marker = randomUUID();
      const prompt = buildPlanReviewAutoFeedbackPrompt({
        requestId: input.request.requestId,
        marker,
        plan: input.request.plan,
      });
      return this.runCorrelatedTurn({
        child: input.child,
        correlationId: marker,
        requireOutput: true,
        signal,
        enqueue: () => adapter.enqueueMessage!(input.child.sessionId, prompt, [], {
          deferUserEventUntilTurnStart: true,
          turnCorrelationId: marker,
        }),
      });
    });
  }

  async deliverLateDecision(input: {
    sourceSessionId: string;
    request: ExitPlanModeRequest;
    response: ExitPlanModeResponse;
  }): Promise<void> {
    const source = sessionRepo.get(input.sourceSessionId);
    if (!source || !isAgentId(source.agentId)) {
      throw new Error('当前计划所属会话不可用，未能提交延迟的计划决定。');
    }
    const adapter = adapterRegistry.get(source.agentId);
    if (!adapter) throw new Error('当前计划所属会话的适配器不可用。');
    await dispatchAdapterMessageWithHandOffRedirect({
      sourceSessionId: input.sourceSessionId,
      sourceAdapter: adapter,
      text: buildLatePlanDecisionPrompt({
        ...(input.request.title ? { title: input.request.title } : {}),
        response: input.response,
      }),
      attachments: [],
      enqueueOptions: {
        idempotencyKey: `plan-late-decision:${input.request.requestId}`,
      },
    });
  }

  async close(child: PlanReviewChildSession): Promise<void> {
    const controller = this.operationAbortControllers.get(child.sessionId) ?? new AbortController();
    this.operationAbortControllers.set(child.sessionId, controller);
    controller.abort(new Error('审阅会话正在关闭，已取消未完成的本轮回复。'));
    const tail = this.operationTails.get(child.sessionId);
    try {
      await sessionManager.close(child.sessionId);
    } catch (error) {
      logger.warn(`[plan-review] close child ${child.sessionId} failed:`, error);
    } finally {
      await tail?.catch(() => undefined);
      if (this.operationAbortControllers.get(child.sessionId) === controller) {
        this.operationAbortControllers.delete(child.sessionId);
      }
    }
  }

  private runSerialized<T>(
    child: PlanReviewChildSession,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = this.operationAbortControllers.get(child.sessionId) ?? new AbortController();
    this.operationAbortControllers.set(child.sessionId, controller);
    const prior = this.operationTails.get(child.sessionId) ?? Promise.resolve();
    const run = (): Promise<T> => {
      if (controller.signal.aborted) {
        return Promise.reject(this.abortReason(controller.signal));
      }
      return operation(controller.signal);
    };
    const result = prior.then(run, run);
    const tail = result.then(() => undefined, () => undefined);
    this.operationTails.set(child.sessionId, tail);
    void tail.finally(() => {
      if (this.operationTails.get(child.sessionId) === tail) {
        this.operationTails.delete(child.sessionId);
      }
    });
    return result;
  }

  private async runCorrelatedTurn(input: {
    child: PlanReviewChildSession;
    correlationId: string;
    requireOutput: boolean;
    signal: AbortSignal;
    enqueue: () => Promise<void>;
  }): Promise<string> {
    if (input.signal.aborted) throw this.abortReason(input.signal);
    let started = false;
    const chunks: string[] = [];
    let finish: ((value: string) => void) | null = null;
    let fail: ((reason: Error) => void) | null = null;
    const output = new Promise<string>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    // Observe terminal failure immediately, including aborts that happen while a missing-runtime
    // enqueue is still recovering. The fulfilled branch never wins the enqueue race: a provider
    // may emit its complete turn synchronously before enqueue() itself returns.
    const outputFailure = output.then<never>(
      () => new Promise<never>(() => {}),
      (error: unknown) => { throw error; },
    );
    const off = eventBus.on('agent-event', (event) => {
      if (event.sessionId !== input.child.sessionId) return;
      if (!started && isMatchingUserMessage(event, input.correlationId)) {
        started = true;
        return;
      }
      if (!started) return;
      const text = assistantText(event);
      if (text) chunks.push(text);
      if (event.kind === 'finished') {
        const result = chunks.join('\n\n').trim();
        if (result || !input.requireOutput) finish?.(result);
        else fail?.(new Error('审阅会话本轮结束，但没有生成可提交的意见。'));
      }
    });
    const timer = setTimeout(() => {
      fail?.(new Error('等待审阅会话回复超时，请重试或手动提交意见。'));
    }, AUTO_FEEDBACK_TIMEOUT_MS);
    const offSession = eventBus.on('session-upserted', (session) => {
      if (session.id === input.child.sessionId && session.lifecycle === 'closed') {
        fail?.(new Error('审阅会话已关闭，未能完成本轮回复。'));
      }
    });
    const onAbort = (): void => {
      fail?.(this.abortReason(input.signal));
    };
    input.signal.addEventListener('abort', onAbort, { once: true });

    try {
      const enqueue = Promise.resolve().then(input.enqueue);
      // Promise.race installs handlers on enqueue as well, so a recovery that rejects after abort
      // is absorbed instead of becoming an unhandled rejection. The adapter's close epoch prevents
      // a late recovery from reviving the now-closed child.
      await Promise.race([enqueue, outputFailure]);
      return await output;
    } finally {
      clearTimeout(timer);
      off();
      offSession();
      input.signal.removeEventListener('abort', onAbort);
    }
  }

  private abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error
      ? signal.reason
      : new Error('审阅会话正在关闭，已取消未完成的本轮回复。');
  }
}

export const planReviewSessionCoordinator = new DefaultPlanReviewSessionCoordinator();
