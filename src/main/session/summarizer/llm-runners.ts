/** Periodic Claude-family session-list summary runner. */
import type { AgentEvent } from '@shared/types';
import {
  isClaudeThinkingLevel,
  type ClaudeThinkingLevel,
} from '@shared/session-metadata';
import { settingsStore } from '@main/store/settings-store';
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
  envOverride?: Readonly<Record<string, string>>;
  evidenceContext?: string;
}

function providerEnv(
  opts: ClaudeFamilyRunnerOptions | undefined,
  key: string,
): string | undefined {
  return opts?.envOverride?.[key] ?? process.env[key];
}

function claudeReasoningSetting(): ClaudeThinkingLevel | undefined {
  const value = settingsStore.get('summaryReasoning');
  if (value === 'minimal') return 'low';
  if (value === 'ultra') return 'max';
  return isClaudeThinkingLevel(value) ? value : undefined;
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

  const result = await runClaudeOneshot({
    cwd,
    prompt: buildSummarizePrompt({
      cwd,
      activity,
      agentName,
      evidenceContext: opts?.evidenceContext,
    }),
    // 展示摘要保持短小，优先使用轻量模型以降低多个会话排队时的成本和延迟。
    // 模型优先级（plan model-wiring-and-handoff-20260514 Step 4.3）：
    //   1. settings.summaryModel（UI 暴露的字符串字段，'' 表示沿用下面 env / alias 链）
    //   2. settings.json 里配的 ANTHROPIC_DEFAULT_HAIKU_MODEL（具体 id）
    //   3. ANTHROPIC_MODEL（用户主模型，没配 haiku 但配了主模型时退而求其次）
    //   4. 'haiku' alias（让什么都没配的环境也能跑，由 SDK / CLI 自己解析）
    // applyClaudeSettingsEnv 在 bootstrap 时已把 settings.json 的 env 注入 process.env。
    model:
      settingsStore.get('summaryModel') ||
      providerEnv(opts, 'ANTHROPIC_DEFAULT_HAIKU_MODEL') ||
      providerEnv(opts, 'ANTHROPIC_MODEL') ||
      'haiku',
    effort: claudeReasoningSetting(),
    systemPrompt: buildSummarizeSystemPrompt(agentName),
    envOverride: opts?.envOverride,
    timeoutMs: settingsStore.get('summaryTimeoutMs'),
    timeoutErrorMessage: '__summarizer_timeout__',
  });

  return cleanCompactResult(result, 800);
}
