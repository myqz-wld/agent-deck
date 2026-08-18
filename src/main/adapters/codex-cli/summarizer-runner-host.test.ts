import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn((key: string) => ({
    summaryModel: 'gpt-summary',
    summaryThinking: 'high',
  } as Record<string, unknown>)[key]),
  runOneshot: vi.fn(async () => 'summary'),
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: mocks.getSetting },
}));
vi.mock('@main/session/oneshot-llm/codex-runner', () => ({
  runCodexOneshot: mocks.runOneshot,
}));

describe('desktop Codex summary runner host', () => {
  it('owns provider summary settings and process execution', async () => {
    const { desktopCodexSummaryRunnerHost: host } = await import('./summarizer-runner-host');

    expect(host.readSummaryModel()).toBe('gpt-summary');
    expect(host.readSummaryReasoning()).toBe('high');
    await expect(host.runOneshot({} as never)).resolves.toBe('summary');
    expect(mocks.runOneshot).toHaveBeenCalledOnce();
  });
});
