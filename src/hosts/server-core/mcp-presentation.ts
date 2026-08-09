import { randomUUID } from 'node:crypto';

import {
  MCP_DIFF_PRESENTATION_SCHEMA,
  MCP_PLAN_PRESENTATION_SCHEMA,
  parseMcpPresentationDisplay,
  parseMcpPresentationFeedback,
  type JsonObject,
  type JsonValue,
  type PendingRequestDto,
} from '@contracts/index';
import type {
  RequestDiffReviewArgs,
  RequestDiffReviewResult,
  RequestPlanReviewArgs,
  RequestPlanReviewResult,
} from '@main/agent-deck-mcp/tools/schemas';
import type {
  ExitPlanModeRequest,
  PlanDeepReviewSession,
} from '@shared/types';

import type { ServerCorePlanReview } from './mcp-plan-review';
import type { ServerCoreMcpPresentationPort } from './mcp-presentation-port';

const DEFAULT_MAX_PENDING = 64;
const DEFAULT_MAX_PENDING_PER_SESSION = 4;

type PresentationResult = RequestPlanReviewResult | RequestDiffReviewResult;

interface PendingPresentation {
  request: PendingRequestDto;
  resolve: (result: PresentationResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface ServerCoreMcpPresentationOptions {
  readonly appendChange: (kind: string, entityId: string, payload: JsonValue) => void;
  readonly createId?: () => string;
  readonly now?: () => number;
  readonly maxPending?: number;
  readonly maxPendingPerSession?: number;
  readonly warn?: (message: string) => void;
  readonly reviewer?: ServerCorePlanReview;
}

function safeSessionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value) && Buffer.byteLength(value) <= 256;
}

function planDisplay(args: RequestPlanReviewArgs): JsonObject {
  return parseMcpPresentationDisplay({
    schema: MCP_PLAN_PRESENTATION_SCHEMA,
    plan: args.plan,
    ...(args.title === undefined ? {} : { title: args.title }),
  })! as unknown as JsonObject;
}

function diffDisplay(args: RequestDiffReviewArgs): JsonObject {
  return parseMcpPresentationDisplay({
    schema: MCP_DIFF_PRESENTATION_SCHEMA,
    mode: args.mode,
    rationale: args.rationale,
    ...(args.title === undefined ? {} : { title: args.title }),
    ...(args.filePath === undefined ? {} : { filePath: args.filePath }),
    ...(args.language === undefined ? {} : { language: args.language }),
    ...(args.instructions === undefined ? {} : { instructions: args.instructions }),
    ...(args.annotations === undefined ? {} : { annotations: args.annotations }),
    ...(args.pr === undefined ? {} : { pr: args.pr }),
    ...(args.conflict === undefined ? {} : { conflict: args.conflict }),
  })! as unknown as JsonObject;
}

/** Core-owned blocking user-presentation gates exposed through Remote pending authority. */
export class ServerCoreMcpPresentation implements ServerCoreMcpPresentationPort {
  private readonly pending = new Map<string, PendingPresentation>();
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly maxPending: number;
  private readonly maxPendingPerSession: number;
  private readonly releases = new Set<Promise<void>>();
  private state: 'idle' | 'running' | 'closed' = 'idle';

  constructor(private readonly options: ServerCoreMcpPresentationOptions) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.maxPendingPerSession = options.maxPendingPerSession ?? DEFAULT_MAX_PENDING_PER_SESSION;
  }

  async start(): Promise<void> {
    if (this.state === 'running') return;
    if (this.state !== 'idle') throw new Error('MCP presentation service is closed');
    this.state = 'running';
  }

  async stop(): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const entry of [...this.pending.values()]) {
      this.finish(entry, { decision: 'timeout' }, null);
    }
    await this.options.reviewer?.stop();
    await Promise.allSettled([...this.releases]);
  }

  requestPlan(
    sessionId: string,
    args: RequestPlanReviewArgs,
  ): Promise<RequestPlanReviewResult> {
    return this.enqueue(sessionId, 'exit-plan', planDisplay(args), null) as
      Promise<RequestPlanReviewResult>;
  }

  requestDiff(
    sessionId: string,
    args: RequestDiffReviewArgs,
  ): Promise<RequestDiffReviewResult> {
    const timeoutMs = args.timeoutMs ?? null;
    return this.enqueue(sessionId, 'diff-review', diffDisplay(args), timeoutMs) as
      Promise<RequestDiffReviewResult>;
  }

  startReview(
    sessionId: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<PlanDeepReviewSession> {
    const entry = this.requirePlan(sessionId, requestId);
    if (!this.options.reviewer) throw new Error('隔离审阅会话不可用。');
    return this.options.reviewer.start({
      sourceSessionId: sessionId,
      request: this.reviewRequest(entry),
      ...(signal ? { signal } : {}),
    });
  }

  async askReview(
    sessionId: string,
    requestId: string,
    question: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const entry = this.requirePlan(sessionId, requestId);
    if (!this.options.reviewer) throw new Error('隔离审阅会话不可用。');
    await this.options.reviewer.ask({
      sourceSessionId: sessionId,
      request: this.reviewRequest(entry),
      question,
      ...(signal ? { signal } : {}),
    });
  }

  generateReviewFeedback(
    sessionId: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const entry = this.requirePlan(sessionId, requestId);
    if (!this.options.reviewer) throw new Error('隔离审阅会话不可用。');
    return this.options.reviewer.generateFeedback({
      sourceSessionId: sessionId,
      request: this.reviewRequest(entry),
      ...(signal ? { signal } : {}),
    });
  }

  list(sessionId: string): PendingRequestDto[] {
    return [...this.pending.values()]
      .filter((entry) => entry.request.sessionId === sessionId)
      .map((entry) => ({ ...entry.request, display: { ...entry.request.display } }));
  }

  respond(
    sessionId: string,
    requestId: string,
    action: string,
    value?: JsonValue,
  ): 'denied' | 'resolved' | null {
    const entry = this.pending.get(requestId);
    if (!entry || entry.request.sessionId !== sessionId) return null;
    if (action !== 'accept' && action !== 'reject') {
      throw new Error('MCP presentation action is invalid');
    }
    if (action === 'accept' && value !== undefined) {
      throw new Error('MCP presentation approval cannot include feedback');
    }
    const feedback = action === 'reject' ? parseMcpPresentationFeedback(value) : undefined;
    this.finish(entry, action === 'accept'
      ? { decision: 'approved' }
      : { decision: 'revise', ...(feedback ? { feedback } : {}) }, null);
    return action === 'accept' ? 'resolved' : 'denied';
  }

  releaseSession(sessionId: string, _reason = 'MCP presentation session closed'): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.request.sessionId !== sessionId) continue;
      this.finish(entry, { decision: 'timeout' }, 'pending.cancelled');
    }
    this.options.reviewer?.releaseSession(sessionId);
  }

  renameSession(fromSessionId: string, toSessionId: string): void {
    if (fromSessionId === toSessionId) return;
    if (!safeSessionId(toSessionId)) throw new Error('MCP presentation target session is invalid');
    this.moveSession(fromSessionId, toSessionId);
    this.options.reviewer?.renameSession(fromSessionId, toSessionId);
  }

  transferSession(fromSessionId: string, toSessionId: string): void {
    if (fromSessionId === toSessionId) return;
    if (!safeSessionId(toSessionId)) throw new Error('MCP presentation target session is invalid');
    for (const entry of this.pending.values()) {
      if (entry.request.sessionId === fromSessionId) this.releaseReview(entry.request.id);
    }
    this.moveSession(fromSessionId, toSessionId);
  }

  private moveSession(fromSessionId: string, toSessionId: string): void {
    for (const entry of this.pending.values()) {
      if (entry.request.sessionId !== fromSessionId) continue;
      entry.request = { ...entry.request, sessionId: toSessionId };
    }
  }

  private enqueue(
    sessionId: string,
    kind: 'diff-review' | 'exit-plan',
    display: JsonObject,
    timeoutMs: number | null,
  ): Promise<PresentationResult> {
    this.assertRunning();
    if (!safeSessionId(sessionId)) throw new Error('MCP presentation session is invalid');
    if (this.pending.size >= this.maxPending) throw new Error('MCP presentation limit reached');
    const perSession = [...this.pending.values()].filter(
      (entry) => entry.request.sessionId === sessionId,
    ).length;
    if (perSession >= this.maxPendingPerSession) {
      throw new Error('Session MCP presentation limit reached');
    }
    const requestId = `mcp-${kind}-${this.createId()}`;
    const createdAt = this.now();
    let resolve!: (result: PresentationResult) => void;
    const promise = new Promise<PresentationResult>((settle) => { resolve = settle; });
    const entry: PendingPresentation = {
      request: {
        id: requestId,
        sessionId,
        kind,
        status: 'pending',
        createdAt,
        expiresAt: timeoutMs === null ? null : createdAt + timeoutMs,
        display,
      },
      resolve,
      timer: null,
    };
    if (timeoutMs !== null) {
      entry.timer = setTimeout(() => {
        this.finish(entry, { decision: 'timeout' }, 'pending.expired');
      }, timeoutMs);
      entry.timer.unref?.();
    }
    this.pending.set(requestId, entry);
    try {
      this.options.appendChange('pending.created', sessionId, {
        requestId,
        kind,
      });
    } catch (error) {
      this.pending.delete(requestId);
      if (entry.timer) clearTimeout(entry.timer);
      throw error;
    }
    return promise;
  }

  private finish(
    entry: PendingPresentation,
    result: PresentationResult,
    change: string | null,
  ): void {
    if (this.pending.get(entry.request.id) !== entry) return;
    this.pending.delete(entry.request.id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.resolve(result);
    this.releaseReview(entry.request.id);
    if (change) {
      try {
        this.options.appendChange(change, entry.request.sessionId, {
          requestId: entry.request.id,
          kind: entry.request.kind,
        });
      } catch {
        try { this.options.warn?.('MCP presentation change publication failed'); } catch {}
      }
    }
  }

  private assertRunning(): void {
    if (this.state !== 'running') throw new Error('MCP presentation service is unavailable');
  }

  private requirePlan(sessionId: string, requestId: string): PendingPresentation {
    this.assertRunning();
    const entry = this.pending.get(requestId);
    if (
      !entry || entry.request.sessionId !== sessionId ||
      entry.request.kind !== 'exit-plan' || entry.request.status !== 'pending'
    ) throw new Error('计划展示已结束或不存在。');
    return entry;
  }

  private reviewRequest(entry: PendingPresentation): ExitPlanModeRequest {
    const display = parseMcpPresentationDisplay(entry.request.display);
    if (!display || display.schema !== MCP_PLAN_PRESENTATION_SCHEMA) {
      throw new Error('计划展示内容无效。');
    }
    return {
      type: 'exit-plan-mode',
      requestId: entry.request.id,
      reviewSource: 'mcp',
      plan: display.plan,
      ...(display.title ? { title: display.title } : {}),
    };
  }

  private releaseReview(requestId: string): void {
    const release = this.options.reviewer?.release(requestId);
    if (!release) return;
    this.releases.add(release);
    void release.catch(() => {
      try { this.options.warn?.('MCP plan review cleanup failed'); } catch {}
    }).finally(() => this.releases.delete(release));
  }
}
