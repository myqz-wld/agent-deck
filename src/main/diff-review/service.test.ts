import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, SessionRecord } from '@shared/types';

import { DiffReviewService, type DiffReviewServiceDependencies } from './service';

function session(id: string): SessionRecord {
  return {
    id,
    agentId: id.startsWith('successor') ? 'claude-code' : 'codex-cli',
    cwd: '/repo',
    title: id,
    source: 'sdk',
    lifecycle: 'active',
    activity: 'waiting',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function setup(
  overrides: Partial<DiffReviewServiceDependencies> = {},
): {
  service: DiffReviewService;
  events: AgentEvent[];
  deliverLateDecision: DiffReviewServiceDependencies['deliverLateDecision'];
} {
  const events: AgentEvent[] = [];
  const deliverLateDecision = overrides.deliverLateDecision ?? vi.fn(async () => undefined);
  const service = new DiffReviewService({
    createRequestId: () => 'diff-1',
    ingest: (event) => events.push(event),
    getSession: (id) => session(id),
    deliverLateDecision,
    ...overrides,
  });
  return { service, events, deliverLateDecision };
}

function request(service: DiffReviewService) {
  return service.request({
    sessionId: 'source',
    agentId: 'codex-cli',
    mode: 'pr',
    rationale: 'Review the cutover change.',
    title: 'B2',
    pr: { before: 'old', after: 'new' },
  });
}

describe('DiffReviewService handoff ownership', () => {
  it('resolves normally before commit and never creates a late successor turn', async () => {
    const { service, deliverLateDecision } = setup();
    const decision = request(service);

    expect(service.respond('source', 'diff-1', { decision: 'approve' })).toBe(true);
    await expect(decision).resolves.toEqual({ decision: 'approved' });
    expect(deliverLateDecision).not.toHaveBeenCalled();
  });

  it('detaches the source promise at commit and resumes the successor once', async () => {
    const delivery = deferred();
    const deliverLateDecision = vi.fn(() => delivery.promise);
    const { service, events } = setup({ deliverLateDecision });
    const decision = request(service);

    expect(service.rehomeForHandOff('source', 'successor-1')).toBe(1);
    await expect(decision).resolves.toEqual({ decision: 'timeout' });
    expect(service.cancelForSession('source')).toBe(0);
    expect(service.listPending('successor-1')).toHaveLength(1);
    expect(events.slice(1).map((event) => ({
      sessionId: event.sessionId,
      type: (event.payload as { type: string }).type,
    }))).toEqual([
      { sessionId: 'source', type: 'diff-review-cancelled' },
      { sessionId: 'successor-1', type: 'diff-review' },
    ]);

    expect(service.respond('successor-1', 'diff-1', { decision: 'approve' })).toBe(true);
    await vi.waitFor(() => expect(deliverLateDecision).toHaveBeenCalledOnce());
    // An identical double-submit observes the same in-flight operation and does not enqueue again.
    expect(service.respond('successor-1', 'diff-1', { decision: 'approve' })).toBe(true);
    expect(deliverLateDecision).toHaveBeenCalledOnce();
    expect(deliverLateDecision).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'source',
      response: { decision: 'approve' },
    }));

    delivery.resolve();
    await vi.waitFor(() => expect(service.listPending('successor-1')).toEqual([]));
  });

  it('keeps immutable source identity across a chained handoff during delivery', async () => {
    const delivery = deferred();
    const deliverLateDecision = vi.fn(() => delivery.promise);
    const { service } = setup({ deliverLateDecision });
    const decision = request(service);
    service.rehomeForHandOff('source', 'successor-1');
    await expect(decision).resolves.toEqual({ decision: 'timeout' });

    expect(service.respond('successor-1', 'diff-1', {
      decision: 'revise',
      feedback: 'add rollback coverage',
    })).toBe(true);
    await vi.waitFor(() => expect(deliverLateDecision).toHaveBeenCalledOnce());
    expect(service.rehomeForHandOff('successor-1', 'successor-2')).toBe(1);
    expect(service.listPending('successor-2')).toHaveLength(1);
    expect(deliverLateDecision).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'source',
    }));

    delivery.resolve();
    await vi.waitFor(() => expect(service.listPending('successor-2')).toEqual([]));
  });

  it('leaves the source gate intact when cutover rolls back without a commit event', async () => {
    const { service, deliverLateDecision } = setup();
    const decision = request(service);

    // A prepared/revoked cutover does not call rehomeForHandOff.
    expect(service.listPending('source')).toHaveLength(1);
    expect(service.listPending('successor-1')).toEqual([]);
    expect(service.respond('source', 'diff-1', {
      decision: 'revise',
      feedback: 'keep working',
    })).toBe(true);
    await expect(decision).resolves.toEqual({
      decision: 'revise',
      feedback: 'keep working',
    });
    expect(deliverLateDecision).not.toHaveBeenCalled();
  });
});
