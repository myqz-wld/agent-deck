import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, SummaryRecord } from '@shared/types';

const harness = vi.hoisted(() => {
  const pending: Array<(value: string | null) => void> = [];
  return {
    currentRevision: 11,
    rebuildAfterRevision: 0,
    summaryEventCount: 1,
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
    countForSession: vi.fn(() => 1),
    emit: vi.fn(),
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
    countForSession: harness.countForSession,
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
    get: vi.fn(() => session),
  },
}));
vi.mock('@main/store/settings-store', () => ({
  settingsStore: {
    get: vi.fn((key: string) => {
      if (key === 'summaryIntervalMs') return 300_000;
      if (key === 'summaryEventCount') return harness.summaryEventCount;
      if (key === 'summaryMaxConcurrent') return 2;
      if (key === 'summaryProvider') return 'claude';
      return undefined;
    }),
  },
}));
vi.mock('@main/adapters/registry', () => ({
  adapterRegistry: {
    get: vi.fn(() => ({ summariseEvents: harness.summariseEvents })),
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
    on: vi.fn(),
    off: vi.fn(),
    emit: harness.emit,
  },
}));
vi.mock('@main/utils/logger', () => ({
  default: {
    scope: () => ({ info: vi.fn(), warn: harness.warn }),
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
    harness.summariseEvents.mockReset();
    harness.summariseEvents.mockImplementation(
      () => new Promise<string | null>((resolve) => harness.pending.push(resolve)),
    );
    harness.insert.mockClear();
    harness.countForSession.mockClear();
    harness.emit.mockClear();
    harness.warn.mockClear();
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
    expect(harness.countForSession).not.toHaveBeenCalled();
    harness.pending.shift()!('继续处理 revision 12');
    await flush();

    expect(harness.insert).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceEventRevision: 12 }),
    );
  });

  it('uses the legacy timestamp count once when the previous row has no revision', async () => {
    harness.previous = {
      ...harness.previous!,
      sourceEventRevision: null,
      sourceRebuildAfterRevision: null,
      generationSource: 'legacy',
    };
    harness.countForSession.mockReturnValue(2);
    const summarizer = new Summarizer();

    await summarizer.scanAll();
    expect(harness.countForSession).toHaveBeenCalledWith(session.id, harness.previous.ts);
    harness.pending.shift()!('从 legacy 游标升级');
    await flush();
    expect(harness.insert).toHaveBeenCalledWith(
      expect.objectContaining({ sourceEventRevision: 11, sourceRebuildAfterRevision: 0 }),
    );
  });

  it('refreshes immediately when a strict rename epoch invalidates an otherwise fresh cursor', async () => {
    harness.currentRevision = 11;
    harness.rebuildAfterRevision = 11;
    harness.summaryEventCount = 10;
    harness.previous = {
      ...harness.previous!,
      sourceEventRevision: 10,
      sourceRebuildAfterRevision: 10,
    };
    harness.countForSession.mockReturnValue(0);
    const summarizer = new Summarizer();

    await summarizer.scanAll();
    expect(harness.countForSession).toHaveBeenCalledWith(session.id, harness.previous!.ts);
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
    harness.summariseEvents.mockRejectedValue(
      new SummaryProviderCapabilityError('claude', 'tool registry cannot be attested'),
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
    // The first concurrent batch can perform two cheap capability checks, but only one warning is
    // emitted and later sessions do not retry. The Codex runner separately proves no turn starts.
    expect(harness.summariseEvents).toHaveBeenCalledTimes(2);
    expect(harness.warn).toHaveBeenCalledTimes(1);
    expect(harness.warn).toHaveBeenCalledWith(
      expect.stringContaining('using local fallback until application restart'),
    );
    expect(summarizer.getLastErrors()['capability-a']?.message).toContain(
      '__claude_summarizer_tools_unproven__',
    );
    expect(summarizer.getLastErrors()['capability-later']?.message).toContain(
      '__claude_summarizer_tools_unproven__',
    );

    const restarted = new Summarizer();
    await restarted.summarizeNow('capability-after-restart');
    expect(harness.summariseEvents).toHaveBeenCalledTimes(3);
    expect(harness.warn).toHaveBeenCalledTimes(2);
  });

  it('does not open the capability circuit for a transient provider failure', async () => {
    harness.summariseEvents.mockRejectedValueOnce(new Error('temporary auth failure'));
    const summarizer = new Summarizer();

    await summarizer.summarizeNow(session.id);
    const retry = summarizer.summarizeNow(session.id);
    expect(harness.summariseEvents).toHaveBeenCalledTimes(2);
    harness.pending.shift()!('provider recovered');
    const recovered = await retry;

    expect(recovered?.generationSource).toBe('llm');
    expect(harness.warn).toHaveBeenCalledTimes(1);
    expect(summarizer.getLastErrors()[session.id]).toBeUndefined();
  });
});
