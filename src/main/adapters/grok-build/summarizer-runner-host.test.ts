import { describe, expect, it, vi } from 'vitest';

const getSetting = vi.hoisted(() => vi.fn((key: string) => ({
  grokCliPath: '/bin/grok',
  summaryModel: 'fable',
  summaryThinking: 'high',
})[key]));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: getSetting },
}));

describe('desktop Grok summary runner host', () => {
  it('owns each provider summary setting', async () => {
    const { desktopGrokSummaryRunnerHost: host } = await import('./summarizer-runner-host');

    expect(host.readBinaryPath()).toBe('/bin/grok');
    expect(host.readSummaryModel()).toBe('fable');
    expect(host.readSummaryReasoning()).toBe('high');
    expect(getSetting.mock.calls.map(([key]) => key)).toEqual([
      'grokCliPath',
      'summaryModel',
      'summaryThinking',
    ]);
  });
});
