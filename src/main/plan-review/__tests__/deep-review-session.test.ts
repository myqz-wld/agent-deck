import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '@shared/types';

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, SessionRecord>(),
  spawn: vi.fn(),
  close: vi.fn(),
  enqueue: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: { get: (id: string) => mocks.sessions.get(id) ?? null },
}));

vi.mock('@main/agent-deck-mcp/tools/handlers/spawn', () => ({
  spawnSessionHandler: mocks.spawn,
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: { close: mocks.close },
}));

vi.mock('@main/adapters/registry', () => ({
  adapterRegistry: {
    get: () => ({ enqueueMessage: mocks.enqueue, sendMessage: vi.fn() }),
  },
}));

vi.mock('@main/ipc/adapters-message-dispatch', () => ({
  dispatchAdapterMessageWithHandOffRedirect: mocks.dispatch,
}));

import { eventBus } from '@main/event-bus';
import { DefaultPlanReviewSessionCoordinator } from '../deep-review-session';

function source(): SessionRecord {
  return {
    id: 'source',
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
    model: 'gpt-test',
    thinking: 'high',
    permissionMode: 'bypassPermissions',
    codexSandbox: 'danger-full-access',
    networkAccessEnabled: false,
    additionalDirectories: ['/tmp', '/shared'],
  };
}

const request = {
  type: 'exit-plan-mode' as const,
  requestId: 'plan-1',
  reviewSource: 'mcp' as const,
  title: 'Plan',
  plan: '1. Validate lifecycle',
};

beforeEach(() => {
  mocks.sessions.clear();
  mocks.sessions.set('source', source());
  mocks.spawn.mockReset();
  mocks.close.mockReset().mockResolvedValue(undefined);
  mocks.enqueue.mockReset().mockResolvedValue(undefined);
  mocks.dispatch.mockReset().mockResolvedValue(undefined);
  mocks.spawn.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify({
      sessionId: 'child',
      adapter: 'codex-cli',
    }) }],
  });
});

describe('DefaultPlanReviewSessionCoordinator', () => {
  it('creates an isolated native fork with inherited runtime access and no lead prompt', async () => {
    const coordinator = new DefaultPlanReviewSessionCoordinator();
    await expect(coordinator.start({ sourceSessionId: 'source', request })).resolves.toEqual({
      sessionId: 'child',
      agentId: 'codex-cli',
    });

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const [args, context, options] = mocks.spawn.mock.calls[0];
    expect(args).toMatchObject({
      adapter: 'codex-cli',
      cwd: '/repo',
      contextMode: 'fork',
      model: 'gpt-test',
      thinking: 'high',
      codexSandbox: 'danger-full-access',
    });
    expect(args.prompt).toContain('Work read-mostly');
    expect(args.prompt).toContain('current plan-owning session in Agent Deck');
    expect(args.prompt).not.toContain('the original session');
    expect(args.prompt).toContain('1. Validate lifecycle');
    expect(context.caller.callerSessionId).toBe('source');
    expect(options).toEqual({
      suppressLeadContext: true,
      codexRuntimeAccess: {
        networkAccessEnabled: false,
        additionalDirectories: ['/tmp', '/shared'],
      },
    });
  });

  it('surfaces a native-fork failure without retrying as fresh', async () => {
    mocks.spawn.mockResolvedValueOnce({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        error: 'native fork unavailable',
        hint: 'wait for the source turn boundary',
      }) }],
    });
    const coordinator = new DefaultPlanReviewSessionCoordinator();

    await expect(coordinator.start({ sourceSessionId: 'source', request }))
      .rejects.toThrow('无法创建隔离的原生 fork');
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn.mock.calls[0][0].contextMode).toBe('fork');
  });

  it('collects only the assistant output after the matching automatic-feedback turn', async () => {
    mocks.enqueue.mockImplementationOnce(async (
      sessionId: string,
      text: string,
      _attachments: unknown[],
      options: { turnCorrelationId: string },
    ) => {
      eventBus.emit('agent-event', {
        sessionId,
        agentId: 'codex-cli',
        kind: 'message',
        payload: { role: 'user', text, turnCorrelationId: options.turnCorrelationId },
        ts: 1,
        source: 'sdk',
      });
      eventBus.emit('agent-event', {
        sessionId,
        agentId: 'codex-cli',
        kind: 'message',
        payload: { role: 'assistant', text: 'Add rollback validation.' },
        ts: 2,
        source: 'sdk',
      });
      eventBus.emit('agent-event', {
        sessionId,
        agentId: 'codex-cli',
        kind: 'finished',
        payload: {},
        ts: 3,
        source: 'sdk',
      });
    });
    const coordinator = new DefaultPlanReviewSessionCoordinator();

    await expect(coordinator.generateFeedback({
      child: { sessionId: 'child', agentId: 'codex-cli' },
      request,
    })).resolves.toBe('Add rollback validation.');
    expect(mocks.enqueue).toHaveBeenCalledWith(
      'child',
      expect.stringContaining('agent-deck-plan-review-internal:auto:'),
      [],
      expect.objectContaining({
        deferUserEventUntilTurnStart: true,
        turnCorrelationId: expect.any(String),
      }),
    );
    expect(mocks.enqueue.mock.calls[0]?.[1]).toContain(
      'current plan-owning session in Agent Deck',
    );
  });

  it('ignores an already-running turn that finishes after automatic feedback is queued', async () => {
    let queued: {
      sessionId: string;
      text: string;
      correlationId: string;
    } | null = null;
    mocks.enqueue.mockImplementationOnce(async (
      sessionId: string,
      text: string,
      _attachments: unknown[],
      options: { turnCorrelationId: string },
    ) => {
      queued = { sessionId, text, correlationId: options.turnCorrelationId };
    });
    const coordinator = new DefaultPlanReviewSessionCoordinator();
    const feedback = coordinator.generateFeedback({
      child: { sessionId: 'child', agentId: 'codex-cli' },
      request,
    });
    await vi.waitFor(() => expect(queued).not.toBeNull());

    eventBus.emit('agent-event', {
      sessionId: 'child',
      agentId: 'codex-cli',
      kind: 'message',
      payload: { role: 'assistant', text: 'Old turn output must be ignored.' },
      ts: 1,
      source: 'sdk',
    });
    eventBus.emit('agent-event', {
      sessionId: 'child',
      agentId: 'codex-cli',
      kind: 'finished',
      payload: {},
      ts: 2,
      source: 'sdk',
    });
    let settled = false;
    void feedback.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const turn = queued!;
    eventBus.emit('agent-event', {
      sessionId: turn.sessionId,
      agentId: 'codex-cli',
      kind: 'message',
      payload: {
        role: 'user',
        text: turn.text,
        turnCorrelationId: turn.correlationId,
      },
      ts: 3,
      source: 'sdk',
    });
    eventBus.emit('agent-event', {
      sessionId: 'child',
      agentId: 'codex-cli',
      kind: 'message',
      payload: { role: 'assistant', text: 'Correct feedback.' },
      ts: 4,
      source: 'sdk',
    });
    eventBus.emit('agent-event', {
      sessionId: 'child',
      agentId: 'codex-cli',
      kind: 'finished',
      payload: {},
      ts: 5,
      source: 'sdk',
    });

    await expect(feedback).resolves.toBe('Correct feedback.');
  });

  it('serializes a question turn before automatic feedback', async () => {
    const queued: Array<{
      sessionId: string;
      text: string;
      correlationId: string;
    }> = [];
    mocks.enqueue.mockImplementation(async (
      sessionId: string,
      text: string,
      _attachments: unknown[],
      options: { turnCorrelationId: string },
    ) => {
      queued.push({ sessionId, text, correlationId: options.turnCorrelationId });
    });
    const coordinator = new DefaultPlanReviewSessionCoordinator();
    const child = { sessionId: 'child', agentId: 'codex-cli' as const };
    const question = coordinator.ask(child, 'What is missing?');
    const feedback = coordinator.generateFeedback({ child, request });
    await vi.waitFor(() => expect(queued).toHaveLength(1));

    const first = queued[0]!;
    eventBus.emit('agent-event', {
      sessionId: first.sessionId,
      agentId: 'codex-cli',
      kind: 'message',
      payload: { role: 'user', text: first.text, turnCorrelationId: first.correlationId },
      ts: 1,
      source: 'sdk',
    });
    eventBus.emit('agent-event', {
      sessionId: first.sessionId,
      agentId: 'codex-cli',
      kind: 'finished',
      payload: {},
      ts: 2,
      source: 'sdk',
    });
    await expect(question).resolves.toBeUndefined();
    await vi.waitFor(() => expect(queued).toHaveLength(2));

    const second = queued[1]!;
    eventBus.emit('agent-event', {
      sessionId: second.sessionId,
      agentId: 'codex-cli',
      kind: 'message',
      payload: { role: 'user', text: second.text, turnCorrelationId: second.correlationId },
      ts: 3,
      source: 'sdk',
    });
    eventBus.emit('agent-event', {
      sessionId: second.sessionId,
      agentId: 'codex-cli',
      kind: 'message',
      payload: { role: 'assistant', text: 'Serialized feedback.' },
      ts: 4,
      source: 'sdk',
    });
    eventBus.emit('agent-event', {
      sessionId: second.sessionId,
      agentId: 'codex-cli',
      kind: 'finished',
      payload: {},
      ts: 5,
      source: 'sdk',
    });
    await expect(feedback).resolves.toBe('Serialized feedback.');
  });

  it('closes the child before waiting and aborts an in-flight correlated turn promptly', async () => {
    let releaseClose!: () => void;
    mocks.close.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseClose = resolve;
    }));
    const coordinator = new DefaultPlanReviewSessionCoordinator();
    const child = { sessionId: 'child', agentId: 'codex-cli' as const };
    const question = coordinator.ask(child, 'What is missing?');
    await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());

    const closing = coordinator.close(child);
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledWith('child'));
    await expect(question).rejects.toThrow('已取消未完成的本轮回复');

    releaseClose();
    await expect(closing).resolves.toBeUndefined();
  });

  it('aborts queued serialized turns without starting them when the child closes', async () => {
    const coordinator = new DefaultPlanReviewSessionCoordinator();
    const child = { sessionId: 'child', agentId: 'codex-cli' as const };
    const question = coordinator.ask(child, 'What is missing?');
    const feedback = coordinator.generateFeedback({ child, request });
    await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());

    const closing = coordinator.close(child);
    await expect(question).rejects.toThrow('已取消未完成的本轮回复');
    await expect(feedback).rejects.toThrow('已取消未完成的本轮回复');
    await expect(closing).resolves.toBeUndefined();
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('aborts a pending recovery enqueue and settles queued work without an unhandled rejection', async () => {
    let rejectEnqueue!: (error: Error) => void;
    mocks.enqueue.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectEnqueue = reject;
    }));
    const coordinator = new DefaultPlanReviewSessionCoordinator();
    const child = { sessionId: 'child', agentId: 'codex-cli' as const };
    const question = coordinator.ask(child, 'What is missing?');
    const feedback = coordinator.generateFeedback({ child, request });
    const questionOutcome = question.then(
      () => ({ status: 'fulfilled' as const, error: null }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    const feedbackOutcome = feedback.then(
      () => ({ status: 'fulfilled' as const, error: null }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());

    const completed = Promise.all([
      questionOutcome,
      feedbackOutcome,
      coordinator.close(child),
    ]);
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('close did not interrupt pending enqueue')),
        250,
      );
    });
    const [questionResult, feedbackResult] = await Promise.race([completed, timeout]).finally(() => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    });

    expect(questionResult.status).toBe('rejected');
    expect(questionResult.error).toEqual(expect.objectContaining({
      message: expect.stringContaining('已取消未完成的本轮回复'),
    }));
    expect(feedbackResult.status).toBe('rejected');
    expect(feedbackResult.error).toEqual(expect.objectContaining({
      message: expect.stringContaining('已取消未完成的本轮回复'),
    }));
    expect(mocks.close).toHaveBeenCalledWith('child');
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);

    rejectEnqueue(new Error('late recovery failure'));
    await Promise.resolve();
    await Promise.resolve();
  });

  it('delivers a late decision as a user turn to the source dispatch path', async () => {
    const coordinator = new DefaultPlanReviewSessionCoordinator();
    await coordinator.deliverLateDecision({
      sourceSessionId: 'source',
      request,
      response: { decision: 'keep-planning', feedback: 'Cover cleanup.' },
    });

    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'source',
      text: expect.stringContaining('Cover cleanup.'),
      attachments: [],
      enqueueOptions: {
        idempotencyKey: 'plan-late-decision:plan-1',
      },
    }));
  });
});
