/**
 * Codex SDK 周期性 summarize oneshot runner（CHANGELOG_<X> A3 + R37 P2-H Step 3.2 重构）。
 *
 * **R37 P2-H 重构**：原 82 LOC（含 codex SDK 设置 / startThread / thread.run / prompt 字面）
 * 下沉到 `@main/session/oneshot-llm/`：
 *   - codex SDK 设置 + thread.run → `runCodexOneshot()`（含可选 race）
 *   - prompt body → `buildSummarizePrompt({agentName: 'Agent'})`
 *   - result 清洗 → `cleanCompactResult()`
 *
 * **R37 P2-H 行为变化**：本 runner 现内置 timeout（settings.summaryTimeoutMs 同 claude），
 * 替代原 caller (summarizer/index.ts) 自己起 Promise.race 的模式。这让 codex summarize 与
 * periodic summary 统一「runner 自带
 * timeout」契约。caller 不再需要知道 codex SDK 没 q.interrupt() 等价物的实现细节。
 *
 * **R37 P1 Step 1.2 (G)**：codex 实例改用 `codex-instance-pool.getCodexInstance()` 应用全局
 * 共享，path 改 → pool 内部 path 比较自动失效。
 *
 * **当前隔离契约**：Codex 0.144 无法证明最终 model-visible built-in tool registry 为空，
 * 所以 periodic summary 在启动 turn 前复用 compact attestation 并 fail-closed。下方
 * read-only / empty cwd / empty MCP 配置保留为未来 provider 能完成 attestation 后的最低配置。
 *
 * spike-A3 实测：5 codex 并发 oneshot 复用 codex app-server 单例，总耗 10s + 单进程
 * ~44 MB RSS。与 claude SDK 同档资源消耗，summarizer 全局 maxConcurrent 不需分桶。
 */
import type { AgentEvent } from '@shared/types';
import { DEFAULT_SUMMARY_REASONING } from '@shared/types';
import { isCodexThinkingLevel, type CodexThinkingLevel } from '@shared/session-metadata';
import { settingsStore } from '@main/store/settings-store';
import {
  buildSummarizePrompt,
  buildSummarizeSystemPrompt,
  cleanCompactResult,
  runCodexOneshot,
} from '@main/session/oneshot-llm';
import { codexCompactorIsolationAttestation } from '@main/session/continuation-context/codex-isolation';
import { SummaryProviderCapabilityError } from '@main/session/summarizer/provider-capability-error';

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

/**
 * 跑一次 codex oneshot 总结。`formatEvents` 由 caller 注入（避免本 runner 重复维护
 * events → prompt 序列化逻辑——summarizer/event-formatter.ts 已有 formatEventsForPrompt
 * 函数措辞精细）。
 *
 * @returns 最多四行的紧凑总结；events 与 evidence 都为空 / codex 返回空 → null；
 *          timer 先赢 / codex 进程错 → throw
 */
export async function summariseCodexSessionViaOneshot(
  cwd: string,
  events: AgentEvent[],
  formatEvents: (events: AgentEvent[]) => string,
  evidenceContext?: string,
): Promise<string | null> {
  const activity = formatEvents(events);
  if (!activity && !evidenceContext) return null;

  // Periodic summaries now include raw user intent. Codex 0.144 accepts the available hardening
  // knobs but cannot attest the final model-visible built-in tool registry, so mirror the compact
  // runtime's fail-closed policy. The scheduler records this diagnostic and emits a labeled local
  // fallback instead of exposing evidence to an unproven runtime.
  const attestation = codexCompactorIsolationAttestation();
  if (!attestation.proven) {
    throw new SummaryProviderCapabilityError('codex', attestation.reason);
  }

  const result = await runCodexOneshot({
    cwd,
    // prompt 与 claude summariseViaLlm 相同结构：提供冻结证据并生成紧凑多行总结。
    // agentName='Agent'：codex 不是 Claude，build-prompt.ts 把主体 `Claude` 改 `Agent`，但
    // 保留 [Claude 说] marker 不变（marker 是 formatEventsForPrompt 固定 label，不本地化）。
    prompt: buildSummarizePrompt({
      cwd,
      activity,
      agentName: 'Agent',
      evidenceContext,
    }),
    systemPrompt: buildSummarizeSystemPrompt('Agent'),
    // plan prancy-forging-penguin:reasoning 改读 settings.summaryReasoning(原 hardcoded 'low'
    // 已下线)。默认值现为 'medium'，用户也可选完整 Codex effort 档位。
    modelReasoningEffort: resolveCodexSummaryReasoning(
      settingsStore.get('summaryReasoning'),
    ),
    // plan prancy-forging-penguin:codex summary model 改读统一字段 settings.summaryModel
    // (不再是 codexSummaryModel — 已下线 + REMOVED_KEYS 清孤儿)。空值保持 undefined，让
    // Codex 直接使用 config.toml 当前模型，不再叠加隐藏的 CODEX_SUMMARY_MODEL env 来源。
    // user 责任:provider=codex 时 settings.summaryModel 填的 model id 必须 codex SDK 可用。
    // 填其他 provider 的 alias 会撞 codex SDK 不识别报错并走 caller fallback。
    model: resolveCodexSummaryModel(settingsStore.get('summaryModel')),
    // R37 P2-H：runner 自己内置 timeout（同 claude path 走 settings.summaryTimeoutMs；
    // 原 caller summarizer/index.ts 起 Promise.race 已删除）。timer 先赢 → 抛
    // `__codex_summarizer_timeout__` 让 caller catch 走 fallback 路径。
    timeoutMs: settingsStore.get('summaryTimeoutMs'),
    timeoutErrorMessage: '__codex_summarizer_timeout__',
  });

  return cleanCompactResult(result, 800);
}
