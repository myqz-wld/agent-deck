import { describe, expect, it, vi } from 'vitest';

import type { AgentAdapter, CreateSessionOptions } from '@main/adapters/types';
import type { AgentEvent, ExitPlanModeRequest, SessionRecord } from '@shared/types';

import { ServerCorePlanReview } from './mcp-plan-review';

const request: ExitPlanModeRequest = {
  type: 'exit-plan-mode',
  requestId: 'mcp-exit-plan-request-a',
  reviewSource: 'mcp',
  title: 'Remote plan',
  plan: '# Steps\n\n1. Preserve authority.',
};

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'source-a',
    agentId: 'codex-cli',
    runtimeProvider: 'private-provider',
    cwd: '/workspaces/project-a',
    title: 'Source',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
    hiddenFromHistory: false,
    cliSessionId: 'native-source-a',
    model: 'gpt-review',
    thinking: 'high',
    codexSandbox: 'workspace-write',
    codexApprovalPolicy: 'never',
    extraAllowWrite: ['/workspaces/shared'],
    networkAccessEnabled: false,
    additionalDirectories: ['/workspaces/reference'],
    ...overrides,
  };
}

function harness(overrides: { source?: SessionRecord; failFirst?: boolean } = {}) {
  const records = new Map<string, SessionRecord>();
  const source = overrides.source ?? session();
  records.set(source.id, source);
  const listeners = new Set<(event: AgentEvent) => void>();
  const emit = (event: AgentEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };
  const discard = vi.fn(async () => undefined);
  let attempts = 0;
  const validateForkSession = vi.fn(async () => undefined);
  const createForkedSession = vi.fn(async (
    _forkSource: unknown,
    target: CreateSessionOptions,
  ) => {
    attempts += 1;
    if (overrides.failFirst && attempts === 1) throw new Error('provider unavailable');
    records.set('review-child', session({
      id: 'review-child',
      agentId: target.agentId,
      title: 'Temporary child',
      cwd: target.cwd,
      hiddenFromHistory: false,
      cliSessionId: 'native-review-child',
      spawnedBy: source.id,
      spawnDepth: (source.spawnDepth ?? 0) + 1,
    }));
    return { sessionId: 'review-child', discard };
  });
  const enqueueMessage = vi.fn(async (
    sessionId: string,
    text: string,
    _attachments: unknown,
    options: { turnCorrelationId?: string },
  ) => {
    emit({
      sessionId,
      agentId: source.agentId,
      kind: 'message',
      payload: { role: 'user', text, turnCorrelationId: options.turnCorrelationId },
      ts: 2,
      source: 'sdk',
    });
    emit({
      sessionId,
      agentId: source.agentId,
      kind: 'message',
      payload: { role: 'assistant', text: text.includes('Synthesize')
        ? 'Add an explicit rollback check.'
        : 'The authority boundary is preserved.' },
      ts: 3,
      source: 'sdk',
    });
    emit({
      sessionId,
      agentId: source.agentId,
      kind: 'finished',
      payload: {},
      ts: 4,
      source: 'sdk',
    });
  });
  const adapter = {
    id: source.agentId,
    capabilities: { canForkSession: true },
    validateForkSession,
    createForkedSession,
    enqueueMessage,
  } as unknown as AgentAdapter;
  const closeSession = vi.fn(async (id: string) => { records.delete(id); });
  const reviewer = new ServerCorePlanReview({
    sessions: {
      get: (id) => records.get(id) ?? null,
      hideFromHistory: (id) => {
        const row = records.get(id);
        if (row) records.set(id, { ...row, hiddenFromHistory: true });
      },
      setSpawnLink: (id, parentSessionId, depth) => {
        const row = records.get(id);
        if (row) records.set(id, { ...row, spawnedBy: parentSessionId, spawnDepth: depth });
      },
      setTitle: (id, title) => {
        const row = records.get(id);
        if (row) records.set(id, { ...row, title });
      },
    },
    closeSession,
    registry: { get: () => adapter },
    events: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  return {
    closeSession,
    createForkedSession,
    enqueueMessage,
    records,
    reviewer,
    validateForkSession,
  };
}

describe('ServerCorePlanReview', () => {
  it('creates one same-adapter native fork with inherited private runtime controls', async () => {
    const state = harness();
    await expect(state.reviewer.start({ sourceSessionId: 'source-a', request }))
      .resolves.toEqual({ sessionId: 'review-child', agentId: 'codex-cli' });
    await expect(state.reviewer.start({ sourceSessionId: 'source-a', request }))
      .resolves.toEqual({ sessionId: 'review-child', agentId: 'codex-cli' });
    expect(state.createForkedSession).toHaveBeenCalledOnce();
    expect(state.validateForkSession).toHaveBeenCalledWith(
      {
        applicationSessionId: 'source-a',
        nativeSessionId: 'native-source-a',
        cwd: '/workspaces/project-a',
      },
      expect.objectContaining({
        agentId: 'codex-cli',
        cwd: '/workspaces/project-a',
        provider: 'private-provider',
        model: 'gpt-review',
        modelReasoningEffort: 'high',
        approvalPolicy: 'never',
        codexSandbox: 'workspace-write',
        networkAccessEnabled: false,
        additionalDirectories: ['/workspaces/reference'],
        extraAllowWrite: ['/workspaces/shared'],
        awaitCanonicalId: true,
      }),
    );
    expect(state.records.get('review-child')).toMatchObject({
      hiddenFromHistory: true,
      spawnedBy: 'source-a',
      spawnDepth: 1,
      title: '计划审阅 · Remote plan',
    });
  });

  it('serializes questions and feedback through the hidden child event stream', async () => {
    const state = harness();
    await expect(state.reviewer.ask({
      sourceSessionId: 'source-a', request, question: 'What is missing?',
    })).resolves.toBeUndefined();
    await expect(state.reviewer.generateFeedback({ sourceSessionId: 'source-a', request }))
      .resolves.toBe('Add an explicit rollback check.');
    expect(state.enqueueMessage).toHaveBeenCalledTimes(2);
    expect(state.enqueueMessage.mock.calls[0]?.[1]).toBe('What is missing?');
    expect(state.enqueueMessage.mock.calls[1]?.[1]).toContain(
      'agent-deck-plan-review-internal:feedback',
    );
    await state.reviewer.release(request.requestId);
    expect(state.closeSession).toHaveBeenCalledWith('review-child');
  });

  it('does not cache a failed create and rejects Grok without invoking a provider', async () => {
    const retry = harness({ failFirst: true });
    await expect(retry.reviewer.start({ sourceSessionId: 'source-a', request }))
      .rejects.toThrow('provider unavailable');
    await expect(retry.reviewer.start({ sourceSessionId: 'source-a', request }))
      .resolves.toMatchObject({ sessionId: 'review-child' });
    expect(retry.createForkedSession).toHaveBeenCalledTimes(2);

    const grok = harness({ source: session({ agentId: 'grok-build' }) });
    await expect(grok.reviewer.start({ sourceSessionId: 'source-a', request }))
      .rejects.toThrow('不能创建隔离的原生计划审阅');
    expect(grok.createForkedSession).not.toHaveBeenCalled();
  });
});
