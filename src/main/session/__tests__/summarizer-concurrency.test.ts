import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppSettings, SessionRecord, SummaryRecord } from '@shared/types';

const harness = vi.hoisted(() => {
  const pending: Array<(value: string | null) => void> = [];
  return {
    pending,
    activeCalls: 0,
    maxActiveCalls: 0,
    nextId: 1,
    summariseEvents: vi.fn(() =>
      new Promise<string | null>((resolve) => {
        harness.activeCalls += 1;
        harness.maxActiveCalls = Math.max(harness.maxActiveCalls, harness.activeCalls);
        pending.push((value) => {
          harness.activeCalls -= 1;
          resolve(value);
        });
      }),
    ),
  };
});

const sessions: SessionRecord[] = ['summary-a', 'summary-b', 'summary-c'].map((id) => ({
  id,
  agentId: 'claude-code',
  cwd: '/repo',
  title: id,
  source: 'sdk',
  lifecycle: 'active',
  activity: 'working',
  startedAt: 1,
  lastEventAt: 1,
  endedAt: null,
  archivedAt: null,
}));

vi.mock('@main/store/summary-repo', () => ({
  summaryRepo: {
    latestForSession: vi.fn(() => null),
    insert: vi.fn((input: Omit<SummaryRecord, 'id'>) => ({
      ...input,
      id: harness.nextId++,
    })),
  },
}));
vi.mock('@main/store/event-repo', () => ({
  eventRepo: {
    countForSession: vi.fn(() => 1),
    findLatestAssistantMessage: vi.fn(() => null),
    findLatestAssistantMessageAfterRevision: vi.fn(() => null),
    findLatestAssistantMessageAtOrBeforeRevision: vi.fn(() => null),
  },
}));
vi.mock('@main/store/event-revision-repo', () => ({
  eventRevisionRepo: {
    state: vi.fn((sessionId: string) => ({
      sessionId,
      revision: 1,
      rebuildAfterRevision: 0,
    })),
  },
}));
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    listActiveAndDormant: vi.fn(() => sessions),
    get: vi.fn((sessionId: string) => sessions.find((session) => session.id === sessionId) ?? null),
  },
}));
vi.mock('@main/store/settings-store', () => ({
  settingsStore: {
    get: vi.fn((key: keyof AppSettings) => {
      if (key === 'summaryEnabled') return true;
      if (key === 'summaryIntervalMs') return 300_000;
      if (key === 'summaryEventCount') return 1;
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
  capturePeriodicSummaryEvidence: vi.fn((sessionId: string) => ({
    sourceEventRevision: 1,
    rebuildAfterRevision: 0,
    events: [
      {
        sessionId,
        agentId: 'claude-code',
        kind: 'message',
        payload: { role: 'assistant', text: 'working' },
        ts: 1,
      } as AgentEvent,
    ],
    promptContext: null,
    activityTruncated: false,
    rawUserInputsTruncated: false,
  })),
}));
vi.mock('@main/event-bus', () => ({
  eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));

import { Summarizer } from '../summarizer';

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('Summarizer concurrency setting', () => {
  beforeEach(() => {
    harness.pending.length = 0;
    harness.activeCalls = 0;
    harness.maxActiveCalls = 0;
    harness.nextId = 1;
    harness.summariseEvents.mockClear();
  });

  it('runs summaries concurrently up to summaryMaxConcurrent and queues the rest', async () => {
    const summarizer = new Summarizer();

    await summarizer.scanAll();
    expect(harness.summariseEvents).toHaveBeenCalledTimes(2);
    expect(harness.activeCalls).toBe(2);

    await summarizer.scanAll();
    expect(harness.summariseEvents).toHaveBeenCalledTimes(2);

    harness.pending.shift()!('summary a');
    await flush();
    await summarizer.scanAll();

    expect(harness.summariseEvents).toHaveBeenCalledTimes(3);
    expect(harness.activeCalls).toBe(2);
    expect(harness.maxActiveCalls).toBe(2);

    for (const resolve of harness.pending.splice(0)) resolve('done');
    await flush();
  });
});
