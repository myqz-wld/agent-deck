import type { RuntimeSelection, StoredAgentEvent } from '@shared/types';
import { DEFAULT_SUMMARY_REASONING } from '@shared/types';
import {
  isGrokThinkingLevel,
  type GrokThinkingLevel,
} from '@shared/session-metadata';
import {
  buildSummarizePrompt,
  buildSummarizeSystemPrompt,
} from '@main/session/oneshot-llm/build-prompt';
import { cleanCompactResult } from '@main/session/oneshot-llm/clean-result';
import { runGrokOneshot } from '@main/session/oneshot-llm/grok-runner';
import { formatEventsForPrompt } from '@main/session/summarizer/event-formatter';

export interface GrokSummaryRunnerHost {
  readBinaryPath(): string | null;
  readSummaryModel(): unknown;
  readSummaryReasoning(): unknown;
  readSummaryTimeoutMs(): number;
}

export function resolveGrokSummaryModel(configured: unknown): string | undefined {
  if (typeof configured !== 'string') return undefined;
  return configured.trim() || undefined;
}

export function resolveGrokSummaryReasoning(configured: unknown): GrokThinkingLevel {
  return isGrokThinkingLevel(configured)
    ? configured
    : DEFAULT_SUMMARY_REASONING;
}

/** Run one bounded Grok summary without discovering desktop settings. */
export async function summariseGrokSessionWithHost(
  host: GrokSummaryRunnerHost,
  cwd: string,
  events: StoredAgentEvent[],
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
    model: resolveGrokSummaryModel(runtime?.model ?? host.readSummaryModel()),
    effort: resolveGrokSummaryReasoning(
      runtime?.thinking ?? host.readSummaryReasoning(),
    ),
    binaryPath: host.readBinaryPath(),
    timeoutMs: host.readSummaryTimeoutMs(),
    timeoutErrorMessage: '__grok_summarizer_timeout__',
    maxOutputBytes: 8_000,
  });

  return cleanCompactResult(result.text, 800);
}
