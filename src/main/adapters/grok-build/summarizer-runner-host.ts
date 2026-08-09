import { settingsStore } from '@main/store/settings-store';
import type { GrokSummaryRunnerHost } from './summarizer-runner-core';

export const desktopGrokSummaryRunnerHost: GrokSummaryRunnerHost = {
  readBinaryPath: () => settingsStore.get('grokCliPath'),
  readSummaryModel: () => settingsStore.get('summaryModel'),
  readSummaryReasoning: () => settingsStore.get('summaryThinking'),
  readSummaryTimeoutMs: () => settingsStore.get('summaryTimeoutMs'),
};
