import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, SessionRecord } from '@shared/types';
import type {
  PlanReviewChildSession,
  PlanReviewSessionCoordinator,
} from '../deep-review-session';
import { PlanReviewService } from '../service';

const child: PlanReviewChildSession = {
  sessionId: 'review-child',
  agentId: 'codex-cli',
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function session(id = 'source'): SessionRecord {
  return {
    id,
    agentId: 'codex-cli',
    cwd: '/repo',
    title: 'Source',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'waiting',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
  };
}

function coordinator(overrides: Partial<PlanReviewSessionCoordinator> = {}): PlanReviewSessionCoordinator {
  return {
    start: vi.fn(async () => child),
    ask: vi.fn(async () => undefined),
    generateFeedback: vi.fn(async () => 'tighten the lifecycle checks'),
    deliverLateDecision: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function setup(overrides: Partial<PlanReviewSessionCoordinator> = {}): {
  service: PlanReviewService;
  events: AgentEvent[];
  coordinator: PlanReviewSessionCoordinator;
} {
  const events: AgentEvent[] = [];
  const reviewCoordinator = coordinator(overrides);
  const service = new PlanReviewService({
    createRequestId: () => 'request-1',
    ingest: (event) => events.push(event),
    getSession: () => session(),
    coordinator: reviewCoordinator,
  });
  return { service, events, coordinator: reviewCoordinator };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PlanReviewService', () => {
  it('waits indefinitely when no timeout is supplied', async () => {
    vi.useFakeTimers();
    const { service } = setup();
    const decision = service.request({
      sessionId: 'source',
      agentId: 'codex-cli',
      plan: 'Plan',
    });
    let settled = false;
    void decision.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(settled).toBe(false);
    expect(service.listPending('source')).toHaveLength(1);

    await service.respond('source', 'request-1', {
      decision: 'approve',
      targetMode: 'default',
    });
    await expect(decision).resolves.toEqual({ decision: 'approved' });
  });

  it('keeps an explicitly timed-out gate pending and delivers a retryable late decision', async () => {
    vi.useFakeTimers();
    const deliverLateDecision = vi
      .fn<PlanReviewSessionCoordinator['deliverLateDecision']>()
      .mockRejectedValueOnce(new Error('adapter unavailable'))
      .mockResolvedValue(undefined);
    const { service } = setup({ deliverLateDecision });
    const decision = service.request({
      sessionId: 'source',
      agentId: 'codex-cli',
      plan: 'Plan',
      timeoutMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(decision).resolves.toEqual({ decision: 'timeout' });
    expect(service.listPending('source')).toHaveLength(1);

    await expect(service.respond('source', 'request-1', {
      decision: 'approve',
      targetMode: 'default',
    })).rejects.toThrow('adapter unavailable');
    expect(service.listPending('source')).toHaveLength(1);

    await expect(service.respond('source', 'request-1', {
      decision: 'approve',
      targetMode: 'default',
    })).resolves.toBe('source');
    expect(deliverLateDecision).toHaveBeenCalledTimes(2);
    expect(service.listPending('source')).toEqual([]);
  });

  it('rehomes a timed-out gate across chained handoffs before source close and retries once safely', async () => {
    vi.useFakeTimers();
    const deliverLateDecision = vi
      .fn<PlanReviewSessionCoordinator['deliverLateDecision']>()
      .mockRejectedValueOnce(new Error('successor temporarily unavailable'))
      .mockResolvedValue(undefined);
    const close = vi.fn(async () => undefined);
    const { service, events } = setup({ deliverLateDecision, close });
    const decision = service.request({
      sessionId: 'source',
      agentId: 'codex-cli',
      plan: 'Plan',
      timeoutMs: 100,
    });
    await service.startDeepReview('source', 'request-1');

    await vi.advanceTimersByTimeAsync(100);
    await expect(decision).resolves.toEqual({ decision: 'timeout' });
    expect(service.rehomeForHandOff('source', 'successor-1')).toBe(1);
    expect(service.rehomeForHandOff('successor-1', 'successor-2')).toBe(1);
    expect(service.cancelForSession('source')).toBe(0);
    expect(service.cancelForSession('successor-1')).toBe(0);
    expect(service.listPending('successor-2')).toHaveLength(1);

    const migratedEvents = events.slice(1).map((event) => ({
      sessionId: event.sessionId,
      type: (event.payload as { type?: string }).type,
    }));
    expect(migratedEvents).toEqual([
      { sessionId: 'source', type: 'exit-plan-cancelled' },
      { sessionId: 'successor-1', type: 'exit-plan-mode' },
      { sessionId: 'successor-1', type: 'exit-plan-cancelled' },
      { sessionId: 'successor-2', type: 'exit-plan-mode' },
    ]);

    await expect(service.respond('successor-2', 'request-1', {
      decision: 'approve',
      targetMode: 'default',
    })).rejects.toThrow('successor temporarily unavailable');
    expect(service.listPending('successor-2')).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();

    await expect(service.respond('successor-2', 'request-1', {
      decision: 'approve',
      targetMode: 'default',
    })).resolves.toBe('successor-2');
    expect(deliverLateDecision).toHaveBeenCalledTimes(2);
    expect(deliverLateDecision).toHaveBeenLastCalledWith(expect.objectContaining({
      sourceSessionId: 'successor-2',
    }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(child);
    expect(service.listPending('successor-2')).toEqual([]);
  });

  it('routes a committed handoff gate before a fallible successor metadata lookup', async () => {
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const deliverLateDecision = vi.fn(async () => undefined);
    const reviewCoordinator = coordinator({ deliverLateDecision });
    let successorReads = 0;
    const service = new PlanReviewService({
      createRequestId: () => 'request-1',
      ingest: (event) => events.push(event),
      getSession: (id) => {
        if (id === 'successor' && successorReads++ === 0) {
          throw new Error('transient sqlite read failure');
        }
        if (id === 'successor') return { ...session(id), agentId: 'claude-code' };
        return session(id);
      },
      coordinator: reviewCoordinator,
    });
    const decision = service.request({
      sessionId: 'source',
      agentId: 'codex-cli',
      plan: 'Plan',
      timeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    await expect(decision).resolves.toEqual({ decision: 'timeout' });

    expect(() => service.rehomeForHandOff('source', 'successor')).not.toThrow();
    expect(service.cancelForSession('source')).toBe(0);
    expect(service.listPending('source')).toEqual([]);
    expect(service.listPending('successor')).toHaveLength(1);
    expect(service.listAllPending('claude-code')).toEqual({
      successor: [expect.objectContaining({ requestId: 'request-1' })],
    });

    await expect(service.respond('successor', 'request-1', {
      decision: 'approve',
      targetMode: 'default',
    })).resolves.toBe('successor');
    expect(deliverLateDecision).toHaveBeenCalledOnce();
    expect(deliverLateDecision).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'successor',
    }));
  });

  it('freezes the first late decision so a retry cannot change the provider turn', async () => {
    vi.useFakeTimers();
    const deliverLateDecision = vi
      .fn<PlanReviewSessionCoordinator['deliverLateDecision']>()
      .mockRejectedValueOnce(new Error('rejected before queue acceptance'))
      .mockResolvedValue(undefined);
    const { service } = setup({ deliverLateDecision });
    const decision = service.request({
      sessionId: 'source',
      agentId: 'codex-cli',
      plan: 'Plan',
      timeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    await expect(decision).resolves.toEqual({ decision: 'timeout' });

    const approve = { decision: 'approve', targetMode: 'default' } as const;
    await expect(service.respond('source', 'request-1', approve))
      .rejects.toThrow('rejected before queue acceptance');
    await expect(service.respond('source', 'request-1', {
      decision: 'keep-planning',
      feedback: 'change the choice',
    })).rejects.toThrow('must use the same decision');
    expect(deliverLateDecision).toHaveBeenCalledTimes(1);

    await expect(service.respond('source', 'request-1', approve)).resolves.toBe('source');
    expect(deliverLateDecision).toHaveBeenCalledTimes(2);
  });

  it('closes a review child once when owner cancellation races late-decision delivery', async () => {
    vi.useFakeTimers();
    let releaseDelivery!: () => void;
    const delivery = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const deliverLateDecision = vi.fn(() => delivery);
    const close = vi.fn(async () => undefined);
    const { service } = setup({ deliverLateDecision, close });
    const decision = service.request({
      sessionId: 'source',
      agentId: 'codex-cli',
      plan: 'Plan',
      timeoutMs: 10,
    });
    await service.startDeepReview('source', 'request-1');
    await vi.advanceTimersByTimeAsync(10);
    await expect(decision).resolves.toEqual({ decision: 'timeout' });

    const response = service.respond('source', 'request-1', {
      decision: 'approve',
      targetMode: 'default',
    });
    await vi.waitFor(() => expect(deliverLateDecision).toHaveBeenCalledOnce());
    expect(service.cancelForSession('source')).toBe(1);
    releaseDelivery();

    await expect(response).resolves.toBeNull();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(close).toHaveBeenCalledWith(child);
    expect(service.listPending('source')).toEqual([]);
  });

  it('returns the successor owner when handoff commits during late-decision delivery', async () => {
    vi.useFakeTimers();
    const delivery = deferred<void>();
    const deliverLateDecision = vi.fn(() => delivery.promise);
    const { service } = setup({ deliverLateDecision });
    const decision = service.request({
      sessionId: 'source',
      agentId: 'codex-cli',
      plan: 'Plan',
      timeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    await expect(decision).resolves.toEqual({ decision: 'timeout' });

    const response = service.respond('source', 'request-1', {
      decision: 'approve',
      targetMode: 'default',
    });
    await vi.waitFor(() => expect(deliverLateDecision).toHaveBeenCalledOnce());
    expect(service.rehomeForHandOff('source', 'successor')).toBe(1);
    delivery.resolve(undefined);

    await expect(response).resolves.toBe('successor');
    expect(service.listPending('source')).toEqual([]);
    expect(service.listPending('successor')).toEqual([]);
  });

  it('uses the cross-adapter successor identity for the migrated card and future review work', async () => {
    const events: AgentEvent[] = [];
    const start = vi.fn(async () => ({
      sessionId: 'claude-review-child',
      agentId: 'claude-code' as const,
    }));
    const reviewCoordinator = coordinator({ start });
    const service = new PlanReviewService({
      createRequestId: () => 'request-1',
      ingest: (event) => events.push(event),
      getSession: (id) => ({
        ...session(id),
        agentId: id === 'claude-successor' ? 'claude-code' : 'codex-cli',
      }),
      coordinator: reviewCoordinator,
    });
    const decision = service.request({
      sessionId: 'codex-source',
      agentId: 'codex-cli',
      plan: 'Plan',
    });

    expect(service.rehomeForHandOff('codex-source', 'claude-successor')).toBe(1);
    expect(events.at(-1)).toMatchObject({
      sessionId: 'claude-successor',
      agentId: 'claude-code',
      payload: { type: 'exit-plan-mode' },
    });
    await service.startDeepReview('claude-successor', 'request-1');
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'claude-successor',
    }));

    await service.respond('claude-successor', 'request-1', {
      decision: 'approve',
      targetMode: 'default',
    });
    await expect(decision).resolves.toEqual({ decision: 'approved' });
  });

  it('creates only one child for concurrent deep-review opens and serializes questions through it', async () => {
    const start = vi.fn(async () => child);
    const ask = vi.fn(async () => undefined);
    const { service } = setup({ start, ask });
    void service.request({
      sessionId: 'source',
      agentId: 'codex-cli',
      plan: 'Plan',
    });

    const [first, second] = await Promise.all([
      service.startDeepReview('source', 'request-1'),
      service.startDeepReview('source', 'request-1'),
    ]);
    expect(first).toEqual(child);
    expect(second).toEqual(child);
    expect(start).toHaveBeenCalledTimes(1);

    await service.askDeepReview('source', 'request-1', 'What is missing?');
    expect(ask).toHaveBeenCalledWith(child, 'What is missing?');
  });

  it('rejects every concurrent deep-review opener when the gate resolves during child startup', async () => {
    const started = deferred<PlanReviewChildSession>();
    const start = vi.fn(() => started.promise);
    const close = vi.fn(async () => undefined);
    const { service } = setup({ start, close });
    const decision = service.request({
      sessionId: 'source',
      agentId: 'codex-cli',
      plan: 'Plan',
    });
    const first = service.startDeepReview('source', 'request-1');
    const second = service.startDeepReview('source', 'request-1');
    expect(service.cancelForSession('source')).toBe(1);
    started.resolve(child);

    await expect(first).rejects.toThrow('resolved while its review session was starting');
    await expect(second).rejects.toThrow('resolved while its review session was starting');
    expect(close).toHaveBeenCalledTimes(1);
    await expect(decision).resolves.toEqual({ decision: 'timeout' });
  });

  it('returns an editable feedback draft without resolving the plan request', async () => {
    const close = vi.fn(async () => undefined);
    const generateFeedback = vi.fn(async () => '  add rollback validation  ');
    const { service } = setup({ close, generateFeedback });
    const decision = service.request({
      sessionId: 'source',
      agentId: 'codex-cli',
      plan: 'Plan',
    });
    await service.startDeepReview('source', 'request-1');

    await expect(
      service.generateFeedbackDraft('source', 'request-1'),
    ).resolves.toBe('  add rollback validation  ');
    expect(service.listPending('source')).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();

    await service.respond('source', 'request-1', {
      decision: 'keep-planning',
      feedback: 'edited rollback validation',
    });
    await expect(decision).resolves.toEqual({
      decision: 'revise',
      feedback: 'edited rollback validation',
    });
    expect(close).toHaveBeenCalledWith(child);
    expect(service.listPending('source')).toEqual([]);
  });

  it('coalesces concurrent feedback draft requests without resolving the gate', async () => {
    const generated = deferred<string>();
    const generateFeedback = vi.fn(() => generated.promise);
    const { service } = setup({ generateFeedback });
    const decision = service.request({
      sessionId: 'source',
      agentId: 'codex-cli',
      plan: 'Plan',
    });
    await service.startDeepReview('source', 'request-1');

    const first = service.generateFeedbackDraft('source', 'request-1');
    const second = service.generateFeedbackDraft('source', 'request-1');
    await vi.waitFor(() => expect(generateFeedback).toHaveBeenCalledTimes(1));
    generated.resolve('draft');

    await expect(Promise.all([first, second])).resolves.toEqual(['draft', 'draft']);
    expect(service.listPending('source')).toHaveLength(1);
    await service.respond('source', 'request-1', { decision: 'keep-planning' });
    await expect(decision).resolves.toEqual({ decision: 'revise' });
  });

  it('rejects a stale feedback draft after the plan owner is handed off', async () => {
    const generated = deferred<string>();
    const generateFeedback = vi.fn(() => generated.promise);
    const { service } = setup({ generateFeedback });
    const decision = service.request({
      sessionId: 'source',
      agentId: 'codex-cli',
      plan: 'Plan',
    });
    await service.startDeepReview('source', 'request-1');
    const draft = service.generateFeedbackDraft('source', 'request-1');
    await vi.waitFor(() => expect(generateFeedback).toHaveBeenCalledTimes(1));

    expect(service.rehomeForHandOff('source', 'successor')).toBe(1);
    generated.resolve('stale draft');

    await expect(draft).rejects.toThrow('changed before the feedback draft was ready');
    expect(service.listPending('successor')).toHaveLength(1);
    await service.respond('successor', 'request-1', {
      decision: 'approve',
      targetMode: 'default',
    });
    await expect(decision).resolves.toEqual({ decision: 'approved' });
  });

  it('closes a prepared child when the owning session is cancelled', async () => {
    const close = vi.fn(async () => undefined);
    const { service, events } = setup({ close });
    const decision = service.request({
      sessionId: 'source',
      agentId: 'codex-cli',
      plan: 'Plan',
    });
    await service.startDeepReview('source', 'request-1');

    expect(service.cancelForSession('source')).toBe(1);
    await expect(decision).resolves.toEqual({ decision: 'timeout' });
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith(child));
    expect(events.at(-1)?.payload).toEqual({
      type: 'exit-plan-cancelled',
      requestId: 'request-1',
    });
  });
});
