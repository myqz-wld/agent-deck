import type { RuntimeSelection, StoredAgentEvent } from '@shared/types';
import { DEFAULT_SUMMARY_REASONING } from '@shared/types';
import {
  isCodexThinkingLevel,
  type CodexThinkingLevel,
} from '@shared/session-metadata';
import {
  buildSummarizePrompt,
  buildSummarizeSystemPrompt,
} from '@main/session/oneshot-llm/build-prompt';
import { cleanCompactResult } from '@main/session/oneshot-llm/clean-result';

export interface CodexSummaryOneshotOptions {
  cwd: string;
  prompt: string;
  systemPrompt: string;
  modelReasoningEffort: CodexThinkingLevel;
  model?: string;
  provider?: string;
  timeoutMs: number;
  timeoutErrorMessage: string;
}

export interface CodexSummaryRunnerHost {
  readSummaryModel(): unknown;
  readSummaryReasoning(): unknown;
  readSummaryTimeoutMs(): number;
  runOneshot(options: CodexSummaryOneshotOptions): Promise<string>;
}

export function resolveCodexSummaryModel(configured: unknown): string | undefined {
  if (typeof configured !== 'string') return undefined;
  const trimmed = configured.trim();
  return trimmed || undefined;
}

export function resolveCodexSummaryReasoning(configured: unknown): CodexThinkingLevel {
  return isCodexThinkingLevel(configured)
    ? configured
    : DEFAULT_SUMMARY_REASONING;
}

/** Build and clean one Codex periodic summary without discovering desktop state. */
export async function summariseCodexSessionWithHost(
  host: CodexSummaryRunnerHost,
  cwd: string,
  events: StoredAgentEvent[],
  formatEvents: (events: StoredAgentEvent[]) => string,
  evidenceContext?: string,
  runtime?: Pick<RuntimeSelection, 'provider' | 'model' | 'thinking'>,
): Promise<string | null> {
  const activity = formatEvents(events);
  if (!activity && !evidenceContext) return null;

  const result = await host.runOneshot({
    cwd,
    prompt: buildSummarizePrompt({
      cwd,
      activity,
      agentName: 'Agent',
      evidenceContext,
    }),
    systemPrompt: buildSummarizeSystemPrompt('Agent'),
    modelReasoningEffort: resolveCodexSummaryReasoning(
      runtime?.thinking ?? host.readSummaryReasoning(),
    ),
    model: resolveCodexSummaryModel(runtime?.model ?? host.readSummaryModel()),
    provider: runtime?.provider?.trim() || undefined,
    timeoutMs: host.readSummaryTimeoutMs(),
    timeoutErrorMessage: '__codex_summarizer_timeout__',
  });

  return cleanCompactResult(result, 800);
}
