import {
  DEFAULT_SUMMARY_REASONING,
  PERIODIC_SUMMARY_TIMEOUT_MS,
  type StoredAgentEvent,
} from '@shared/types';
import {
  isClaudeThinkingLevel,
  type ClaudeThinkingLevel,
} from '@shared/session-metadata';
import {
  buildSummarizePrompt,
  buildSummarizeSystemPrompt,
} from '@main/session/oneshot-llm/build-prompt';
import { cleanCompactResult } from '@main/session/oneshot-llm/clean-result';
import type {
  ClaudeOneshotOptions,
} from '@main/session/oneshot-llm/claude-runner-core';
import { formatEventsForPrompt } from './event-formatter';

export interface ClaudeFamilyRunnerOptions {
  agentName?: 'Claude' | 'Agent';
  runtimeProvider?: string;
  model?: string;
  thinking?: string;
  evidenceContext?: string;
}

interface ClaudeSummaryGatewayProfile {
  readonly modelAliases: { readonly haiku?: string };
  readonly settingsPath?: string;
}

export interface ClaudeSummaryRunnerHost {
  readonly readSummaryThinking: () => unknown;
  readonly resolveGatewayProfile: (
    provider?: string,
  ) => ClaudeSummaryGatewayProfile | null;
  readonly runOneshot: (options: ClaudeOneshotOptions) => Promise<string>;
}

function claudeReasoningSetting(value: unknown): ClaudeThinkingLevel {
  if (value === 'ultra') return 'max';
  return isClaudeThinkingLevel(value) ? value : DEFAULT_SUMMARY_REASONING;
}

/** Build and clean one Claude-family summary without discovering host settings. */
export async function summariseClaudeSessionWithHost(
  host: ClaudeSummaryRunnerHost,
  cwd: string,
  events: StoredAgentEvent[],
  opts?: ClaudeFamilyRunnerOptions,
): Promise<string | null> {
  const activity = formatEventsForPrompt(events);
  if (!activity && !opts?.evidenceContext) return null;
  const agentName = opts?.agentName ?? 'Claude';
  const profile = host.resolveGatewayProfile(opts?.runtimeProvider);
  const explicitModel = opts?.model?.trim();
  const result = await host.runOneshot({
    cwd,
    prompt: buildSummarizePrompt({
      cwd,
      activity,
      agentName,
      evidenceContext: opts?.evidenceContext,
    }),
    model:
      explicitModel ||
      profile?.modelAliases.haiku ||
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ||
      'haiku',
    effort: claudeReasoningSetting(
      opts?.thinking ?? host.readSummaryThinking(),
    ),
    systemPrompt: buildSummarizeSystemPrompt(agentName),
    settingsPath: profile?.settingsPath,
    timeoutMs: PERIODIC_SUMMARY_TIMEOUT_MS,
    timeoutErrorMessage: '__summarizer_timeout__',
  });
  return cleanCompactResult(result, 800);
}
