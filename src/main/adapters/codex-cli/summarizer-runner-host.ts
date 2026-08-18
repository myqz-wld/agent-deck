import { settingsStore } from '@main/store/settings-store';
import { runCodexOneshot } from '@main/session/oneshot-llm/codex-runner';
import type { CodexSummaryRunnerHost } from './summarizer-runner-core';

export const desktopCodexSummaryRunnerHost: CodexSummaryRunnerHost = {
  readSummaryModel: () => settingsStore.get('summaryModel'),
  readSummaryReasoning: () => settingsStore.get('summaryThinking'),
  runOneshot: runCodexOneshot,
};
