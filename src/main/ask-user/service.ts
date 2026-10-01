import { randomUUID } from 'node:crypto';
import type { AgentEvent, AskUserQuestionRequest, SessionRecord } from '@shared/types';
import { parseAskUserAnswer } from '@shared/ask-user';
import type { AskUserArgs, AskUserResult } from '@main/agent-deck-mcp/tools/schemas/ask-user';
import { eventBus } from '@main/event-bus';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';

interface PendingQuestion {
  sessionId: string;
  agentId: string;
  payload: AskUserQuestionRequest;
  resolve: (result: AskUserResult) => void;
  detach: () => void;
}

export interface AskUserDependencies {
  createId: () => string;
  ingest: (event: AgentEvent) => void;
  getSession: (sessionId: string) => SessionRecord | null;
}

/** MCP questions share the native question UI, but never require a provider-specific responder. */
export class AskUserService {
  private readonly pending = new Map<string, PendingQuestion>();

  constructor(private readonly deps: AskUserDependencies) {}

  request(sessionId: string, agentId: string, args: AskUserArgs, signal?: AbortSignal): Promise<AskUserResult> {
    if (signal?.aborted) return Promise.resolve({ status: 'cancelled', answers: [] });
    if (this.pending.size >= 64 || this.listPending(sessionId).length >= 4) {
      throw new Error('待回答的问题数量已达上限（每会话 4 组、全局 64 组），请先处理已有问题。');
    }
    const requestId = this.deps.createId();
    let resolve!: PendingQuestion['resolve'];
    const promise = new Promise<AskUserResult>((settle) => { resolve = settle; });
    const abort = () => this.cancel(requestId);
    const entry: PendingQuestion = {
      sessionId, agentId, resolve,
      payload: {
        type: 'ask-user-question', requestId,
        questions: args.questions.map((question) => ({
          ...question, options: question.options?.map((option) => ({ ...option })) ?? [],
        })),
      },
      detach: () => signal?.removeEventListener('abort', abort),
    };
    this.pending.set(requestId, entry);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      this.emit(entry, entry.payload);
    } catch (error) {
      this.pending.delete(requestId);
      entry.detach();
      throw error;
    }
    return promise;
  }

  respond(sessionId: string, requestId: string, value: unknown): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.sessionId !== sessionId) return false;
    const answer = parseAskUserAnswer(entry.payload.questions, value);
    this.pending.delete(requestId);
    entry.detach();
    entry.resolve({ status: 'answered', answers: answer.answers });
    this.emitSettled(entry, { type: 'ask-question-answered', requestId, ...answer });
    return true;
  }

  listPending(sessionId: string): AskUserQuestionRequest[] {
    return [...this.pending.values()].filter((entry) => entry.sessionId === sessionId)
      .map((entry) => structuredClone(entry.payload));
  }

  listAllPending(agentId: string): Record<string, AskUserQuestionRequest[]> {
    const out: Record<string, AskUserQuestionRequest[]> = {};
    for (const entry of this.pending.values()) {
      const session = this.deps.getSession(entry.sessionId);
      if (!session || session.lifecycle === 'closed' || session.agentId !== agentId) continue;
      (out[entry.sessionId] ??= []).push(structuredClone(entry.payload));
    }
    return out;
  }

  cancelForSession(sessionId: string, emit = true): void {
    for (const [id, entry] of this.pending) {
      if (entry.sessionId === sessionId) this.cancel(id, emit);
    }
  }

  renameSession(from: string, to: string): void {
    for (const entry of this.pending.values()) {
      if (entry.sessionId === from) entry.sessionId = to;
    }
  }

  private cancel(requestId: string, emit = true): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    entry.detach();
    entry.resolve({ status: 'cancelled', answers: [] });
    if (emit) this.emitSettled(entry, { type: 'ask-question-cancelled', requestId });
  }

  private emit(entry: PendingQuestion, payload: unknown): void {
    this.deps.ingest({
      sessionId: entry.sessionId, agentId: entry.agentId,
      kind: 'waiting-for-user', payload, ts: Date.now(), source: 'sdk',
    });
  }

  private emitSettled(entry: PendingQuestion, payload: unknown): void {
    try { this.emit(entry, payload); }
    catch { /* Authoritative hydration removes the card if its session projection is gone. */ }
  }
}

export const askUserService = new AskUserService({
  createId: () => `mcp-ask-${randomUUID()}`,
  ingest: (event) => sessionManager.ingest(event),
  getSession: (sessionId) => sessionRepo.get(sessionId),
});

export function getAskUserService(): AskUserService {
  return askUserService;
}

eventBus.on('session-upserted', (session) => {
  if (session.lifecycle === 'closed') askUserService.cancelForSession(session.id);
});
eventBus.on('session-removed', (sessionId) => askUserService.cancelForSession(sessionId, false));
eventBus.on('session-renamed', ({ from, to }) => askUserService.renameSession(from, to));
eventBus.on('session-hand-off-committed', ({ sourceSessionId }) => {
  askUserService.cancelForSession(sourceSessionId);
});
eventBus.on('agent-event', (event) => {
  if (event.kind === 'finished' || event.kind === 'session-end') {
    askUserService.cancelForSession(event.sessionId);
  }
});
