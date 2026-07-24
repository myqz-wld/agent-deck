/** Periodic Claude-family session-list summary runner. */
import type { AgentEvent } from '@shared/types';
import { DEFAULT_SUMMARY_REASONING } from '@shared/types';
import {
  isClaudeThinkingLevel,
  type ClaudeThinkingLevel,
} from '@shared/session-metadata';
import { settingsStore } from '@main/store/settings-store';
import { resolveClaudeGatewayProfile } from '@main/adapters/claude-code/gateway-profiles';
import {
  buildSummarizePrompt,
  cleanCompactResult,
  runClaudeOneshot,
  buildSummarizeSystemPrompt,
  type AgentName,
} from '@main/session/oneshot-llm';
import { formatEventsForPrompt } from './event-formatter';

interface ClaudeFamilyRunnerOptions {
  agentName?: AgentName;
  runtimeProvider?: string;
  model?: string;
  thinking?: string;
  evidenceContext?: string;
}

function claudeReasoningSetting(value: unknown): ClaudeThinkingLevel {
  if (value === 'minimal') return 'low';
  if (value === 'ultra') return 'max';
  return isClaudeThinkingLevel(value) ? value : DEFAULT_SUMMARY_REASONING;
}

/**
 * 用本地 OAuth + Claude Code SDK 跑一次 oneshot 总结，生成最多四行的具体状态摘要。
 *
 * **超时**：底层 cli.js 子进程因代理超时 / 鉴权死锁 / API 限流卡在等待 result 时，
 * for-await 会永远不返回 → inFlight 槽永不释放，maxConcurrent 个卡死后整个
 * Summarizer 不再产新总结。runClaudeOneshot 内部 raceWithTimeout 给硬上限：
 * - 优先调 q.interrupt() 让 SDK 自己优雅退（清掉 cli.js 子进程）
 * - 兜底 throw `__summarizer_timeout__`，让外层 catch 走兜底路径
 */
export async function summariseViaLlm(
  cwd: string,
  events: AgentEvent[],
  opts?: ClaudeFamilyRunnerOptions,
): Promise<string | null> {
  const activity = formatEventsForPrompt(events);
  if (!activity && !opts?.evidenceContext) return null;
  const agentName = opts?.agentName ?? 'Claude';
  const profile = resolveClaudeGatewayProfile(opts?.runtimeProvider);
  const explicitModel = opts?.model?.trim();

  const result = await runClaudeOneshot({
    cwd,
    prompt: buildSummarizePrompt({
      cwd,
      activity,
      agentName,
      evidenceContext: opts?.evidenceContext,
    }),
    // Periodic summaries prefer each Claude-family provider's low-cost Haiku alias.
    model:
      explicitModel ||
      profile?.modelAliases.haiku ||
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ||
      'haiku',
    effort: claudeReasoningSetting(
      opts?.thinking ?? settingsStore.get('summaryThinking'),
    ),
    systemPrompt: buildSummarizeSystemPrompt(agentName),
    settingsPath: profile?.settingsPath,
    timeoutMs: settingsStore.get('summaryTimeoutMs'),
    timeoutErrorMessage: '__summarizer_timeout__',
  });

  return cleanCompactResult(result, 800);
}
