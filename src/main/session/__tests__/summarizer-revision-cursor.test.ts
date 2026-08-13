import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppSettings, SummaryRecord } from '@shared/types';

const harness = vi.hoisted(() => {
  const pending: Array<(value: string | null) => void> = [];
  return {
    currentRevision: 11,
    rebuildAfterRevision: 0,
    summaryEventCount: 1,
    summaryAdapter: 'claude-code' as AppSettings['summaryAdapter'],
    previous: null as SummaryRecord | null,
    nextId: 10,
    pending,
    summariseEvents: vi.fn(
      () => new Promise<string | null>((resolve) => pending.push(resolve)),
    ),
    insert: vi.fn((input: Omit<SummaryRecord, 'id'>) => ({
      ...input,
      id: 10,
    })),
    adapterGet: vi.fn(),
    listeners: new Map<string, Set<(payload: unknown) => void>>(),
    missingSessions: new Set<string>(),
    eventOn: vi.fn((name: string, handler: (payload: unknown) => void) => {
      const handlers = harness.listeners.get(name) ?? new Set();
      handlers.add(handler);
      harness.listeners.set(name, handlers);
    }),
    eventOff: vi.fn((name: string, handler: (payload: unknown) => void) => {
      harness.listeners.get(name)?.delete(handler);
    }),
    emit: vi.fn((name: string, payload: unknown) => {
      for (const handler of harness.listeners.get(name) ?? []) handler(payload);
    }),
    info: vi.fn(),
    warn: vi.fn(),
  };
});

const session = {
  id: 'revision-summary',
  agentId: 'claude-code',
  cwd: '/repo',
  title: 'summary',
  source: 'sdk',
  lifecycle: 'active',
  activity: 'working',
  startedAt: 1,
  lastEventAt: 1,
  endedAt: null,
  archivedAt: null,
};

const event: AgentEvent & { id: number } = {
  id: 1,
  sessionId: session.id,
  agentId: session.agentId,
  kind: 'message',
  payload: { role: 'assistant', text: 'working' },
  ts: 1,
};

vi.mock('@main/store/summary-repo', () => ({
  summaryRepo: {
    latestForSession: vi.fn(() => harness.previous),
    insert: harness.insert,
  },
}));
vi.mock('@main/store/event-repo', () => ({
  eventRepo: {
    findLatestAssistantMessage: vi.fn(() => null),
    findLatestAssistantMessageAfterRevision: vi.fn(() => null),
    findLatestAssistantMessageAtOrBeforeRevision: vi.fn(() => null),
  },
}));
vi.mock('@main/store/event-revision-repo', () => ({
  eventRevisionRepo: {
    state: vi.fn(() => ({
      sessionId: session.id,
      revision: harness.currentRevision,
      rebuildAfterRevision: harness.rebuildAfterRevision,
    })),
  },
}));
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    listActiveAndDormant: vi.fn(() => [session]),
    get: vi.fn((sessionId: string) =>
      harness.missingSessions.has(sessionId) ? null : session
    ),
  },
}));
vi.mock('@main/store/settings-store', () => ({
  settingsStore: {
    get: vi.fn((key: string) => {
      if (key === 'summaryIntervalMs') return 300_000;
      if (key === 'summaryEventCount') return harness.summaryEventCount;
      if (key === 'summaryMaxConcurrent') return 2;
      if (key === 'summaryAdapter') return harness.summaryAdapter;
      if (key === 'summaryRuntimeProvider' || key === 'summaryModel') return '';
      if (key === 'summaryThinking') return 'low';
      return undefined;
    }),
  },
}));
vi.mock('@main/adapters/registry', () => ({
  adapterRegistry: {
    get: harness.adapterGet,
  },
}));
vi.mock('../summarizer/evidence-snapshot', () => ({
  capturePeriodicSummaryEvidence: vi.fn(() => ({
    sourceEventRevision: harness.currentRevision,
    rebuildAfterRevision: harness.rebuildAfterRevision,
    events: [event],
    promptContext: '{"recentUserInputs":["improve summaries"]}',
    activityTruncated: false,
    rawUserInputsTruncated: false,
  })),
}));
vi.mock('@main/event-bus', () => ({
  eventBus: {
    on: harness.eventOn,
    off: harness.eventOff,
    emit: harness.emit,
  },
}));
vi.mock('@main/utils/logger', () => ({
  default: {
    scope: () => ({ info: harness.info, warn: harness.warn }),
  },
}));

import { Summarizer } from '../summarizer';
import { SummaryProviderCapabilityError } from '../summarizer/provider-capability-error';

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('Summarizer persisted revision cursor', () => {
  beforeEach(() => {
    harness.currentRevision = 11;
    harness.rebuildAfterRevision = 0;
    harness.summaryEventCount = 1;
    harness.summaryAdapter = 'claude-code';
    harness.previous = {
      id: 1,
      sessionId: session.id,
      content: 'previous',
      trigger: 'time',
      ts: Date.now(),
      sourceEventRevision: 10,
      sourceRebuildAfterRevision: 0,
      generationSource: 'llm',
    };
    harness.pending.length = 0;
    harness.nextId = 10;
    harness.listeners.clear();
    harness.missingSessions.clear();
    harness.summariseEvents.mockReset();
    harness.summariseEvents.mockImplementation(
      () => new Promise<string | null>((resolve) => harness.pending.push(resolve)),
    );
    harness.insert.mockClear();
    harness.emit.mockClear();
    harness.eventOn.mockClear();
    harness.eventOff.mockClear();
    harness.info.mockClear();
    harness.warn.mockClear();
    harness.adapterGet.mockReset().mockReturnValue({
      summariseEvents: harness.summariseEvents,
    });
    harness.insert.mockImplementation((input) => ({
      ...input,
      id: harness.nextId++,
    }));
  });

  it('stores the pre-await boundary and summarizes a revision that arrives while the provider waits', async () => {
    const summarizer = new Summarizer();

    await summarizer.scanAll();
    expect(harness.summariseEvents).toHaveBeenCalledTimes(1);
    expect(harness.pending).toHaveLength(1);

    // This event revision arrives after evidence capture but before the provider result.
    harness.currentRevision = 12;
    harness.pending.shift()!('优化周期总结\n进展：已冻结 revision 11');
    await flush();

    expect(harness.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEventRevision: 11,
        sourceRebuildAfterRevision: 0,
        generationSource: 'llm',
      }),
    );

    await summarizer.scanAll();
    expect(harness.summariseEvents).toHaveBeenCalledTimes(2);
    harness.pending.shift()!('继续处理 revision 12');
    await flush();

    expect(harness.insert).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceEventRevision: 12 }),
    );
  });

  it('refreshes immediately when a rename epoch invalidates an otherwise fresh cursor', async () => {
    harness.currentRevision = 11;
    harness.rebuildAfterRevision = 11;
    harness.summaryEventCount = 10;
    harness.previous = {
      ...harness.previous!,
      sourceEventRevision: 10,
      sourceRebuildAfterRevision: 10,
    };
    const summarizer = new Summarizer();

    await summarizer.scanAll();
    expect(harness.summariseEvents).toHaveBeenCalledTimes(1);
    harness.pending.shift()!('重建后刷新摘要');
    await flush();
    expect(harness.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEventRevision: 11,
        sourceRebuildAfterRevision: 11,
      }),
    );
  });

  it('aggregates concurrent capability failures and keeps the circuit open until restart', async () => {
    harness.summaryAdapter = 'codex-cli';
    harness.summariseEvents.mockRejectedValue(
      new SummaryProviderCapabilityError(
        'codex-cli',
        'tool isolation cannot be attested',
      ),
    );
    const summarizer = new Summarizer();

    const [first, second] = await Promise.all([
      summarizer.summarizeNow('capability-a'),
      summarizer.summarizeNow('capability-b'),
    ]);
    const later = await summarizer.summarizeNow('capability-later');

    expect(first?.generationSource).toBe('stats-fallback');
    expect(second?.generationSource).toBe('stats-fallback');
    expect(later?.generationSource).toBe('stats-fallback');
    // The first concurrent batch can perform two cheap capability checks, but the provider-scoped
    // diagnostic is emitted once and later sessions do not retry.
    expect(harness.summariseEvents).toHaveBeenCalledTimes(2);
    expect(harness.warn).toHaveBeenCalledTimes(1);
    expect(harness.warn).toHaveBeenCalledWith(
      'summarizer state degraded',
      expect.objectContaining({
        event: 'summarizer-state',
        state: 'provider-capability-failure',
        previousState: null,
        transition: 'initial',
      }),
    );
    expect(harness.info).not.toHaveBeenCalled();
    expect(summarizer.getLastErrors()).toEqual({});
    const firstDiagnostics = JSON.stringify(harness.warn.mock.calls);
    expect(firstDiagnostics).not.toContain('codex-cli:');
    expect(firstDiagnostics).not.toContain('tool isolation cannot be attested');

    const restarted = new Summarizer();
    await restarted.summarizeNow('capability-after-restart');
    expect(harness.summariseEvents).toHaveBeenCalledTimes(3);
    expect(harness.warn).toHaveBeenCalledTimes(2);
    expect(harness.info).not.toHaveBeenCalled();
    expect(restarted.getLastErrors()).toEqual({});
  });

  it('contains diagnostic sink failure without changing fallback, raw UI error, or recovery', async () => {
    const rawError =
      'temporary provider failure /Users/private https://example.test/?token=secret';
    harness.summariseEvents.mockRejectedValueOnce(new Error(rawError));
    harness.warn.mockImplementationOnce(() => {
      throw new Error('diagnostic sink failure');
    });
    const summarizer = new Summarizer();

    const fallback = await summarizer.summarizeNow(session.id);
    expect(fallback?.generationSource).toBe('stats-fallback');
    expect(summarizer.getLastErrors()[session.id]?.message).toBe(rawError);
    expect(JSON.stringify(harness.warn.mock.calls)).not.toContain(rawError);
    const retry = summarizer.summarizeNow(session.id);
    expect(harness.summariseEvents).toHaveBeenCalledTimes(2);
    harness.pending.shift()!('provider recovered');
    const recovered = await retry;

    expect(recovered?.generationSource).toBe('llm');
    expect(harness.warn).toHaveBeenCalledTimes(1);
    expect(harness.info).toHaveBeenCalledWith(
      'summarizer state recovered',
      expect.objectContaining({
        state: 'healthy',
        previousState: 'transient-failure:provider-error',
      }),
    );
    expect(summarizer.getLastErrors()[session.id]).toBeUndefined();
  });

  it('rethrows the exact manual persistence error and releases in-flight state', async () => {
    const manualSessionId = 'manual-session /Users/private token=secret';
    const persistenceError = new Error(
      'insert failed https://example.test/?token=secret',
    );
    harness.summariseEvents.mockResolvedValueOnce('provider result');
    harness.insert.mockImplementationOnce(() => {
      throw persistenceError;
    });
    const summarizer = new Summarizer();

    await expect(summarizer.summarizeNow(manualSessionId)).rejects.toBe(
      persistenceError,
    );
    expect(harness.warn).toHaveBeenCalledWith(
      'summarizer state degraded',
      expect.objectContaining({
        state: 'transient-failure:internal-error',
        previousState: 'healthy',
        transition: 'transition',
      }),
    );
    const emitted = JSON.stringify(harness.warn.mock.calls);
    expect(emitted).not.toContain(manualSessionId);
    expect(emitted).not.toContain(persistenceError.message);
    expect(summarizer.getLastErrors()).toEqual({});

    const retry = summarizer.summarizeNow(manualSessionId);
    expect(harness.summariseEvents).toHaveBeenCalledTimes(2);
    harness.pending.shift()!('retry succeeded');
    await expect(retry).resolves.toMatchObject({
      generationSource: 'llm',
    });
  });

  it('drops stale rename outcomes without raw logs or a stuck in-flight key', async () => {
    const rawError =
      'renamed provider failure /Users/private https://example.test/?token=secret';
    let rejectProvider!: (error: Error) => void;
    harness.summariseEvents.mockImplementationOnce(
      () => new Promise<string | null>((_resolve, reject) => {
        rejectProvider = reject;
      }),
    );
    const summarizer = new Summarizer();
    summarizer.start();

    try {
      await summarizer.scanAll();
      harness.missingSessions.add(session.id);
      harness.emit('session-renamed', {
        from: session.id,
        to: 'renamed-session /Users/private',
      });
      rejectProvider(new Error(rawError));
      await flush();

      expect(harness.insert).not.toHaveBeenCalled();
      expect(summarizer.getLastErrors()).toEqual({});
      expect(harness.warn).not.toHaveBeenCalled();
      expect(harness.info).not.toHaveBeenCalled();

      const renamed = summarizer.summarizeNow('renamed-session /Users/private');
      expect(harness.summariseEvents).toHaveBeenCalledTimes(2);
      harness.pending.shift()!('renamed session recovered');
      await expect(renamed).resolves.toMatchObject({
        generationSource: 'llm',
      });
      const emitted = JSON.stringify([
        ...harness.warn.mock.calls,
        ...harness.info.mock.calls,
      ]);
      expect(emitted).not.toContain(rawError);
      expect(emitted).not.toContain('/Users/private');
    } finally {
      summarizer.stop();
    }
  });

  it('forgets raw UI and transition state when a session is removed', async () => {
    const summarizer = new Summarizer();
    summarizer.start();

    try {
      harness.summariseEvents.mockRejectedValueOnce(new Error('first raw failure'));
      await summarizer.summarizeNow(session.id);
      expect(summarizer.getLastErrors()[session.id]?.message).toBe(
        'first raw failure',
      );
      expect(harness.warn).toHaveBeenCalledTimes(1);

      harness.emit('session-removed', session.id);
      expect(summarizer.getLastErrors()).toEqual({});

      harness.summariseEvents.mockRejectedValueOnce(new Error('second raw failure'));
      await summarizer.summarizeNow(session.id);
      expect(harness.warn).toHaveBeenCalledTimes(2);
      expect(harness.warn.mock.calls[1]?.[1]).toMatchObject({
        state: 'transient-failure:provider-error',
        previousState: null,
        transition: 'initial',
      });
    } finally {
      summarizer.stop();
    }
  });

  it('dispatches the Grok summary provider to the grok-build adapter', async () => {
    harness.summaryAdapter = 'grok-build';
    const summarizer = new Summarizer();
    const pending = summarizer.summarizeNow(session.id);
    expect(harness.adapterGet).toHaveBeenCalledWith('grok-build');
    harness.pending.shift()!('grok-generated summary');

    await expect(pending).resolves.toMatchObject({
      content: 'grok-generated summary',
      generationSource: 'llm',
    });
  });

  it('drains scheduled and manual work before stop completes', async () => {
    const summarizer = new Summarizer();
    summarizer.start();

    await summarizer.scanAll();
    const manual = summarizer.summarizeNow('manual-drain');
    expect(harness.summariseEvents).toHaveBeenCalledTimes(2);

    let stopped = false;
    const firstStop = summarizer.stop();
    expect(summarizer.stop()).toBe(firstStop);
    const stop = firstStop.then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    await expect(summarizer.summarizeNow('blocked-during-stop')).resolves.toBeNull();
    expect(harness.summariseEvents).toHaveBeenCalledTimes(2);

    harness.pending.shift()!('scheduled drained');
    await flush();
    expect(stopped).toBe(false);

    harness.pending.shift()!('manual drained');
    await expect(manual).resolves.toMatchObject({ content: 'manual drained' });
    await stop;

    expect(stopped).toBe(true);
    expect(harness.insert).toHaveBeenCalledTimes(2);
    await expect(summarizer.summarizeNow('blocked-after-stop')).resolves.toBeNull();
    expect(harness.summariseEvents).toHaveBeenCalledTimes(2);
    expect(harness.eventOff).toHaveBeenCalledWith(
      'session-removed',
      expect.any(Function),
    );
    expect(harness.eventOff).toHaveBeenCalledWith(
      'session-renamed',
      expect.any(Function),
    );
  });
});
