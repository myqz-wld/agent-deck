/**
 * Codex SDK 周期性 summarize oneshot runner（CHANGELOG_<X> A3 + R37 P2-H Step 3.2 重构）。
 *
 * **R37 P2-H 重构**：原 82 LOC（含 codex SDK 设置 / startThread / thread.run / prompt 字面）
 * 下沉到 `@main/session/oneshot-llm/`：
 *   - codex SDK 设置 + thread.run → `runCodexOneshot()`（含可选 race）
 *   - prompt body → `buildSummarizePrompt({agentName: 'Agent'})`
 *   - result 清洗 → `cleanCompactResult()`
 *
 * 本 runner 使用周期总结的应用内置 timeout，替代 caller 自己起 Promise.race 的模式。
 * caller 不需要知道 Codex SDK 的取消实现细节。
 *
 * **R37 P1 Step 1.2 (G)**：codex 实例改用 `codex-instance-pool.getCodexInstance()` 应用全局
 * 共享，path 改 → pool 内部 path 比较自动失效。
 *
 * **当前隔离契约**：Codex 0.144.1 仍无法证明最终 model-visible built-in tool registry
 * 为空。周期 summary 与 Continuation Context checkpoint 经 user 明确接受该剩余风险后，
 * 都允许在 empty cwd / read-only / no network / empty MCP + dynamic tools / disabled
 * executable features 的外围硬化边界内运行；checkpoint 另有 structured schema、evidence、
 * active-fact carry-forward、revision 与 CAS persistence 校验。
 *
 * spike-A3 实测：5 codex 并发 oneshot 复用 codex app-server 单例，总耗 10s + 单进程
 * ~44 MB RSS。与 claude SDK 同档资源消耗，summarizer 全局 maxConcurrent 不需分桶。
 */
import type { RuntimeSelection, StoredAgentEvent } from '@shared/types';
import { summariseCodexSessionWithHost } from './summarizer-runner-core';
import { desktopCodexSummaryRunnerHost } from './summarizer-runner-host';

export {
  resolveCodexSummaryModel,
  resolveCodexSummaryReasoning,
} from './summarizer-runner-core';

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
  events: StoredAgentEvent[],
  formatEvents: (events: StoredAgentEvent[]) => string,
  evidenceContext?: string,
  runtime?: Pick<RuntimeSelection, 'provider' | 'model' | 'thinking'>,
): Promise<string | null> {
  // The desktop host owns the hardened process runner and settings. Core keeps prompt, precedence,
  // and result semantics without constructing or discovering the app-server instance.
  return summariseCodexSessionWithHost(
    desktopCodexSummaryRunnerHost,
    cwd,
    events,
    formatEvents,
    evidenceContext,
    runtime,
  );
}
