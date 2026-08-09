import { randomUUID } from 'node:crypto';

import { buildCreateSessionOptions, isAgentId } from '@main/adapters/options-builder';
import type {
  AgentAdapter,
  CreateSessionOptions,
  ForkSessionSource,
  InitialSessionRegistration,
} from '@main/adapters/types';
import {
  buildPlanReviewForkPrompt,
} from '@main/plan-review/prompts';
import {
  isClaudeThinkingLevel,
  isCodexThinkingLevel,
} from '@shared/session-metadata';
import {
  isCodexApprovalPolicy,
  isSelectablePermissionMode,
  NO_PLAN_REVIEW_DIALOGUE_FEEDBACK,
  type AgentEvent,
  type ExitPlanModeRequest,
  type PlanDeepReviewSession,
  type SessionRecord,
} from '@shared/types';

const REVIEW_TIMEOUT_MS = 5 * 60_000;
const FEEDBACK_MARKER = '<!-- agent-deck-plan-review-internal:feedback:';

interface ReviewState {
  readonly request: ExitPlanModeRequest;
  sourceSessionId: string;
  child: PlanDeepReviewSession | null;
  childPromise: Promise<PlanDeepReviewSession> | null;
  readonly controller: AbortController;
  tail: Promise<void>;
  released: boolean;
}

export interface ServerCorePlanReviewRepositoryPort {
  get(sessionId: string): SessionRecord | null;
  hideFromHistory(sessionId: string): void;
  setSpawnLink(sessionId: string, parentSessionId: string, depth: number): void;
  setTitle(sessionId: string, title: string): void;
}

export interface ServerCorePlanReviewEventPort {
  subscribe(listener: (event: AgentEvent) => void): () => void;
}

export interface ServerCorePlanReviewOptions {
  readonly sessions: ServerCorePlanReviewRepositoryPort;
  readonly closeSession: (sessionId: string) => Promise<void>;
  readonly registry: { get(adapterId: string): AgentAdapter | undefined };
  readonly events: ServerCorePlanReviewEventPort;
  readonly warn?: (message: string) => void;
}

function feedbackPrompt(requestId: string): string {
  return `${FEEDBACK_MARKER}${requestId} -->
Synthesize the material revision feedback supported by the plan and the review dialogue in this
isolated companion. Preserve decisions already confirmed by the user. Return only a concise,
directly actionable feedback draft in the user's language. Do not approve the plan or use tools.`;
}

function assistantText(event: AgentEvent): string | null {
  if (event.kind !== 'message') return null;
  const payload = event.payload as { role?: unknown; text?: unknown; error?: unknown } | null;
  return payload?.role === 'assistant' && typeof payload.text === 'string' && payload.error !== true
    ? payload.text.trim()
    : null;
}

function matchingUser(event: AgentEvent, correlationId: string): boolean {
  if (event.kind !== 'message') return false;
  const payload = event.payload as { role?: unknown; turnCorrelationId?: unknown } | null;
  return payload?.role === 'user' && payload.turnCorrelationId === correlationId;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('审阅会话操作已取消。');
}

function reviewRegistration(source: SessionRecord): InitialSessionRegistration {
  return {
    spawnLink: {
      parentSessionId: source.id,
      depth: (source.spawnDepth ?? 0) + 1,
    },
    hiddenFromHistory: true,
    onRegistered: () => undefined,
  };
}

function reviewTarget(source: SessionRecord, prompt: string): CreateSessionOptions {
  const registration = reviewRegistration(source);
  if (source.agentId === 'claude-code') {
    return buildCreateSessionOptions('claude-code', {
      cwd: source.cwd,
      prompt,
      ...(source.runtimeProvider ? { gateway: source.runtimeProvider } : {}),
      ...(source.model ? { model: source.model } : {}),
      ...(isClaudeThinkingLevel(source.thinking)
        ? { claudeCodeEffortLevel: source.thinking }
        : {}),
      ...(isSelectablePermissionMode(source.permissionMode)
        ? { permissionMode: source.permissionMode }
        : source.permissionMode === 'dontAsk'
          ? { permissionMode: 'default' }
          : {}),
      ...(source.claudeCodeSandbox ? { claudeCodeSandbox: source.claudeCodeSandbox } : {}),
      ...(source.extraAllowWrite?.length ? { extraAllowWrite: source.extraAllowWrite } : {}),
      awaitCanonicalId: true,
      initialSessionRegistration: registration,
    });
  }
  if (source.agentId !== 'codex-cli') {
    throw new Error('当前 provider 不支持隔离的原生计划审阅。');
  }
  const target = buildCreateSessionOptions('codex-cli', {
    cwd: source.cwd,
    prompt,
    ...(source.runtimeProvider ? { provider: source.runtimeProvider } : {}),
    ...(source.model ? { model: source.model } : {}),
    ...(isCodexThinkingLevel(source.thinking) ? { modelReasoningEffort: source.thinking } : {}),
    ...(isCodexApprovalPolicy(source.codexApprovalPolicy)
      ? { approvalPolicy: source.codexApprovalPolicy }
      : {}),
    ...(source.codexSandbox ? { codexSandbox: source.codexSandbox } : {}),
    ...(source.extraAllowWrite?.length ? { extraAllowWrite: source.extraAllowWrite } : {}),
    awaitCanonicalId: true,
    initialSessionRegistration: registration,
  });
  // These two fields are intentionally excluded from the public options builder. This Core-owned
  // native fork is a trusted lifecycle caller and inherits the already-persisted source controls.
  return {
    ...target,
    ...(source.networkAccessEnabled === null || source.networkAccessEnabled === undefined
      ? {}
      : { networkAccessEnabled: source.networkAccessEnabled }),
    ...(source.additionalDirectories?.length
      ? { additionalDirectories: source.additionalDirectories }
      : {}),
  };
}

/** Core-owned native review forks used by the shared Local/Remote plan-review dialog. */
export class ServerCorePlanReview {
  private readonly reviews = new Map<string, ReviewState>();

  constructor(private readonly options: ServerCorePlanReviewOptions) {}

  start(input: {
    sourceSessionId: string;
    request: ExitPlanModeRequest;
    signal?: AbortSignal;
  }): Promise<PlanDeepReviewSession> {
    const state = this.state(input.sourceSessionId, input.request);
    if (!state.childPromise) {
      const operation = this.createChild(state);
      state.childPromise = operation;
      void operation.catch(() => {
        if (
          this.reviews.get(input.request.requestId) === state &&
          state.childPromise === operation &&
          !state.released
        ) state.childPromise = null;
      });
    }
    return this.waitFor(state.childPromise, input.signal);
  }

  async ask(input: {
    sourceSessionId: string;
    request: ExitPlanModeRequest;
    question: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const text = input.question.trim();
    if (!text) throw new Error('审阅问题不能为空。');
    const child = await this.start(input);
    const state = this.requireState(input.sourceSessionId, input.request.requestId);
    if (!state) throw new Error('审阅会话尚未创建。');
    await this.serial(state, input.signal, (signal) => this.turn(child, text, false, signal));
  }

  async generateFeedback(input: {
    sourceSessionId: string;
    request: ExitPlanModeRequest;
    signal?: AbortSignal;
  }): Promise<string> {
    const state = this.requireState(input.sourceSessionId, input.request.requestId, false);
    if (!state || !state.child) return NO_PLAN_REVIEW_DIALOGUE_FEEDBACK;
    const current = state;
    const child = state.child;
    return this.serial(current, input.signal, (signal) =>
      this.turn(child, feedbackPrompt(input.request.requestId), true, signal));
  }

  release(requestId: string): Promise<void> {
    const state = this.reviews.get(requestId);
    if (!state) return Promise.resolve();
    this.reviews.delete(requestId);
    state.released = true;
    state.controller.abort(new Error('计划展示已结束，审阅会话正在关闭。'));
    return this.closeWhenReady(state);
  }

  releaseSession(sessionId: string): void {
    for (const [requestId, state] of this.reviews) {
      if (state.sourceSessionId === sessionId || state.child?.sessionId === sessionId) {
        void this.release(requestId);
      }
    }
  }

  renameSession(fromSessionId: string, toSessionId: string): void {
    for (const state of this.reviews.values()) {
      if (state.sourceSessionId === fromSessionId) state.sourceSessionId = toSessionId;
      if (state.child?.sessionId === fromSessionId) {
        state.child = { ...state.child, sessionId: toSessionId };
      }
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.reviews.keys()].map((requestId) => this.release(requestId)));
  }

  private state(sourceSessionId: string, request: ExitPlanModeRequest): ReviewState {
    const existing = this.reviews.get(request.requestId);
    if (existing) {
      if (existing.sourceSessionId !== sourceSessionId || existing.request.plan !== request.plan) {
        throw new Error('计划审阅身份已变化，请刷新后重试。');
      }
      return existing;
    }
    const state: ReviewState = {
      request,
      sourceSessionId,
      child: null,
      childPromise: null,
      controller: new AbortController(),
      tail: Promise.resolve(),
      released: false,
    };
    this.reviews.set(request.requestId, state);
    return state;
  }

  private requireState(
    sourceSessionId: string,
    requestId: string,
    required = true,
  ): ReviewState | null {
    const state = this.reviews.get(requestId) ?? null;
    if (!state && required) throw new Error('审阅会话尚未创建。');
    if (state && state.sourceSessionId !== sourceSessionId) {
      throw new Error('计划审阅所属会话已变化。');
    }
    return state;
  }

  private async createChild(state: ReviewState): Promise<PlanDeepReviewSession> {
    const source = this.options.sessions.get(state.sourceSessionId);
    if (
      !source || source.source !== 'sdk' || source.lifecycle !== 'active' ||
      source.archivedAt !== null || !isAgentId(source.agentId) ||
      source.agentId === 'grok-build' || !source.cliSessionId
    ) throw new Error('源会话当前不能创建隔离的原生计划审阅。');
    const adapter = this.options.registry.get(source.agentId);
    if (
      adapter?.capabilities.canForkSession !== true ||
      !adapter.validateForkSession || !adapter.createForkedSession
    ) throw new Error('当前 provider 不支持隔离的原生计划审阅。');
    const prompt = buildPlanReviewForkPrompt({
      requestId: state.request.requestId,
      plan: state.request.plan,
      ...(state.request.title ? { title: state.request.title } : {}),
    });
    const target = reviewTarget(source, prompt);
    const forkSource: ForkSessionSource = {
      applicationSessionId: source.id,
      nativeSessionId: source.cliSessionId,
      cwd: source.cwd,
    };
    await adapter.validateForkSession(forkSource, target);
    const handle = await adapter.createForkedSession(forkSource, target);
    try {
      if (state.released || state.controller.signal.aborted) {
        await handle.discard();
        throw abortError(state.controller.signal);
      }
      let record = this.options.sessions.get(handle.sessionId);
      if (!record || record.agentId !== source.agentId) {
        throw new Error('原生 fork 未注册可信的审阅会话。');
      }
      if (!record.hiddenFromHistory) {
        this.options.sessions.hideFromHistory(handle.sessionId);
        record = this.options.sessions.get(handle.sessionId);
      }
      const depth = (source.spawnDepth ?? 0) + 1;
      if (!record?.spawnedBy) {
        this.options.sessions.setSpawnLink(handle.sessionId, source.id, depth);
        record = this.options.sessions.get(handle.sessionId);
      }
      if (record?.spawnedBy !== source.id || record.spawnDepth !== depth) {
        throw new Error('审阅会话的来源绑定无效。');
      }
      this.options.sessions.setTitle(
        handle.sessionId,
        state.request.title ? `计划审阅 · ${state.request.title}`.slice(0, 80) : '计划深度审阅',
      );
      const child: PlanDeepReviewSession = { sessionId: handle.sessionId, agentId: source.agentId };
      state.child = child;
      return child;
    } catch (error) {
      await handle.discard().catch(() => undefined);
      throw error;
    }
  }

  private serial<T>(
    state: ReviewState,
    externalSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const linked = this.linkedSignal(state.controller.signal, externalSignal);
      try {
        if (linked.signal.aborted) throw abortError(linked.signal);
        return await operation(linked.signal);
      } finally {
        linked.cleanup();
      }
    };
    const result = state.tail.then(run, run);
    state.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async turn(
    child: PlanDeepReviewSession,
    text: string,
    requireOutput: boolean,
    signal: AbortSignal,
  ): Promise<string> {
    const adapter = this.options.registry.get(child.agentId);
    if (!adapter?.enqueueMessage) throw new Error('审阅会话当前无法接收问题。');
    const correlationId = randomUUID();
    let started = false;
    const chunks: string[] = [];
    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;
    const output = new Promise<string>((done, fail) => { resolve = done; reject = fail; });
    const off = this.options.events.subscribe((event) => {
      if (event.sessionId !== child.sessionId) return;
      if (!started && matchingUser(event, correlationId)) { started = true; return; }
      if (!started) return;
      const message = assistantText(event);
      if (message) chunks.push(message);
      if (event.kind === 'finished') {
        const result = chunks.join('\n\n').trim();
        if (result || !requireOutput) resolve(result);
        else reject(new Error('审阅会话没有生成可提交的意见。'));
      } else if (event.kind === 'session-end') {
        reject(new Error('审阅会话已关闭。'));
      }
    });
    const timer = setTimeout(() => reject(new Error('等待审阅会话回复超时。')), REVIEW_TIMEOUT_MS);
    timer.unref?.();
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const enqueue = adapter.enqueueMessage(child.sessionId, text, [], {
        deferUserEventUntilTurnStart: true,
        turnCorrelationId: correlationId,
      });
      await Promise.race([enqueue, output.then(() => undefined)]);
      return await output;
    } finally {
      clearTimeout(timer);
      off();
      signal.removeEventListener('abort', onAbort);
    }
  }

  private waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError(signal));
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(abortError(signal));
      signal.addEventListener('abort', onAbort, { once: true });
      void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  private linkedSignal(primary: AbortSignal, secondary: AbortSignal | undefined): {
    signal: AbortSignal;
    cleanup(): void;
  } {
    if (!secondary) return { signal: primary, cleanup: () => undefined };
    const controller = new AbortController();
    const abort = (signal: AbortSignal): void => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    const onPrimary = (): void => abort(primary);
    const onSecondary = (): void => abort(secondary);
    primary.addEventListener('abort', onPrimary, { once: true });
    secondary.addEventListener('abort', onSecondary, { once: true });
    if (primary.aborted) abort(primary);
    else if (secondary.aborted) abort(secondary);
    return {
      signal: controller.signal,
      cleanup: () => {
        primary.removeEventListener('abort', onPrimary);
        secondary.removeEventListener('abort', onSecondary);
      },
    };
  }

  private async closeWhenReady(state: ReviewState): Promise<void> {
    const child = state.child ?? await state.childPromise?.catch(() => null) ?? null;
    await state.tail.catch(() => undefined);
    if (!child) return;
    try { await this.options.closeSession(child.sessionId); }
    catch { try { this.options.warn?.('Plan review child cleanup failed'); } catch {} }
  }
}
