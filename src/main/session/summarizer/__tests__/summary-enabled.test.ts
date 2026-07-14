import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getSession: vi.fn(),
  getAdapter: vi.fn(),
  captureEvidence: vi.fn(),
  latestSummary: vi.fn(() => null),
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: {
    get: vi.fn((key: string) => (key === 'summaryEnabled' ? false : undefined)),
  },
}));
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    listActiveAndDormant: harness.listSessions,
    get: harness.getSession,
  },
}));
vi.mock('@main/store/summary-repo', () => ({
  summaryRepo: {
    latestForSession: harness.latestSummary,
    insert: vi.fn(),
  },
}));
vi.mock('@main/store/event-repo', () => ({
  eventRepo: {
    countForSession: vi.fn(),
    findLatestAssistantMessage: vi.fn(),
    findLatestAssistantMessageAfterRevision: vi.fn(),
    findLatestAssistantMessageAtOrBeforeRevision: vi.fn(),
  },
}));
vi.mock('@main/store/event-revision-repo', () => ({
  eventRevisionRepo: { state: vi.fn() },
}));
vi.mock('@main/adapters/registry', () => ({
  adapterRegistry: { get: harness.getAdapter },
}));
vi.mock('../evidence-snapshot', () => ({
  capturePeriodicSummaryEvidence: harness.captureEvidence,
}));
vi.mock('@main/event-bus', () => ({
  eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));

import { Summarizer } from '..';

describe('Summarizer summaryEnabled guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not start model work from scheduled or manual entry points when disabled', async () => {
    const summarizer = new Summarizer();

    await summarizer.scanAll();
    const manual = await summarizer.summarizeNow('disabled-summary');

    expect(manual).toBeNull();
    expect(harness.listSessions).not.toHaveBeenCalled();
    expect(harness.getSession).not.toHaveBeenCalled();
    expect(harness.captureEvidence).not.toHaveBeenCalled();
    expect(harness.getAdapter).not.toHaveBeenCalled();
  });
});
