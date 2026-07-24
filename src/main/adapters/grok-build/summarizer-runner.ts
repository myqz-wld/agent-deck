import type { AgentEvent, RuntimeSelection } from '@shared/types';
import { DEFAULT_SUMMARY_REASONING } from '@shared/types';
import {
  isGrokThinkingLevel,
  type GrokThinkingLevel,
} from '@shared/session-metadata';
import { settingsStore } from '@main/store/settings-store';
import {
  buildSummarizePrompt,
  buildSummarizeSystemPrompt,
  cleanCompactResult,
  runGrokOneshot,
} from '@main/session/oneshot-llm';
import { formatEventsForPrompt } from '@main/session/summarizer/event-formatter';

export function resolveGrokSummaryModel(configured: unknown): string | undefined {
  if (typeof configured !== 'string') return undefined;
  return configured.trim() || undefined;
}

export function resolveGrokSummaryReasoning(configured: unknown): GrokThinkingLevel {
  return isGrokThinkingLevel(configured)
    ? configured
    : DEFAULT_SUMMARY_REASONING;
}

/** Run a bounded, hardened Grok Build oneshot for the session-list display summary. */
export async function summariseGrokSessionViaOneshot(
  cwd: string,
  events: AgentEvent[],
  evidenceContext?: string,
  runtime?: Pick<RuntimeSelection, 'provider' | 'model' | 'thinking'>,
): Promise<string | null> {
  const activity = formatEventsForPrompt(events);
  if (!activity && !evidenceContext) return null;

  const result = await runGrokOneshot({
    prompt: buildSummarizePrompt({
      cwd,
      activity,
      agentName: 'Agent',
      evidenceContext,
    }),
    systemPrompt: buildSummarizeSystemPrompt('Agent'),
    model: resolveGrokSummaryModel(runtime?.model ?? settingsStore.get('summaryModel')),
    effort: resolveGrokSummaryReasoning(
      runtime?.thinking ?? settingsStore.get('summaryThinking'),
    ),
    binaryPath: settingsStore.get('grokCliPath'),
    timeoutMs: settingsStore.get('summaryTimeoutMs'),
    timeoutErrorMessage: '__grok_summarizer_timeout__',
    maxOutputBytes: 8_000,
  });

  return cleanCompactResult(result.text, 800);
}
