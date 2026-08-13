import type { StoredAgentEvent } from '@shared/types';
import { settingsStore } from '@main/store/settings-store';
import { resolveClaudeGatewayProfile } from '@main/adapters/claude-code/gateway-profiles';
import { runClaudeOneshot } from '@main/session/oneshot-llm';
import {
  summariseClaudeSessionWithHost,
  type ClaudeFamilyRunnerOptions,
} from './claude-runner-core';

export type {
  ClaudeFamilyRunnerOptions,
  ClaudeSummaryRunnerHost,
} from './claude-runner-core';
export { summariseClaudeSessionWithHost } from './claude-runner-core';

/** Desktop Claude-family summary runner. */
export function summariseViaLlm(
  cwd: string,
  events: StoredAgentEvent[],
  options?: ClaudeFamilyRunnerOptions,
): Promise<string | null> {
  return summariseClaudeSessionWithHost({
    readSummaryThinking: () => settingsStore.get('summaryThinking'),
    readSummaryTimeoutMs: () => settingsStore.get('summaryTimeoutMs'),
    resolveGatewayProfile: (provider) => resolveClaudeGatewayProfile(provider),
    runOneshot: runClaudeOneshot,
  }, cwd, events, options);
}
