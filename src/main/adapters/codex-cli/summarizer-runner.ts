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
 * codex handoff（handoff-runner.ts 早就内置 60s timeout）+ claude 双路统一「runner 自带
 * timeout」契约。caller 不再需要知道 codex SDK 没 q.interrupt() 等价物的实现细节。
 *
 * **R37 P1 Step 1.2 (G)**：codex 实例改用 `codex-instance-pool.getCodexInstance()` 应用全局
 * 共享，path 改 → pool 内部 path 比较自动失效。
 *
 * **行为不变**（与原 runner 一致）：
 * - sandboxMode='read-only' 禁 codex 真跑工具改文件
 * - approvalPolicy='never' 不等审批（read-only 下也无可审批）
 * - skipGitRepoCheck=true 跳 git repo 校验
 * - modelReasoningEffort 读 settings.summaryReasoning（默认 low；可选 minimal..ultra）
 *
 * spike-A3 实测：5 codex 并发 oneshot 复用 codex app-server 单例，总耗 10s + 单进程
 * ~44 MB RSS。与 claude SDK 同档资源消耗，summarizer 全局 maxConcurrent 不需分桶。
 */
import type { AgentEvent } from '@shared/types';
import { settingsStore } from '@main/store/settings-store';
import {
  buildSummarizePrompt,
  cleanCompactResult,
  runCodexOneshot,
} from '@main/session/oneshot-llm';

/**
 * 跑一次 codex oneshot 总结。`formatEvents` 由 caller 注入（避免本 runner 重复维护
 * events → prompt 序列化逻辑——summarizer/event-formatter.ts 已有 formatEventsForPrompt
 * 函数措辞精细）。
 *
 * @returns 总结文本（≤ 120 字符）；events 没有可总结内容 / codex 返回空 → null；
 *          timer 先赢 / codex 进程错 → throw
 */
export async function summariseCodexSessionViaOneshot(
  cwd: string,
  events: AgentEvent[],
  formatEvents: (events: AgentEvent[]) => string,
): Promise<string | null> {
  const activity = formatEvents(events);
  if (!activity) return null;

  const result = await runCodexOneshot({
    cwd,
    // prompt 与 claude summariseViaLlm 相同结构：列举近期事件类型，让模型一句话总结。
    // agentName='Agent'：codex 不是 Claude，build-prompt.ts 把主体 `Claude` 改 `Agent`，但
    // 保留 [Claude 说] marker 不变（marker 是 formatEventsForPrompt 固定 label，不本地化）。
    prompt: buildSummarizePrompt({ cwd, activity, agentName: 'Agent' }),
    // plan prancy-forging-penguin:reasoning 改读 settings.summaryReasoning(原 hardcoded 'low'
    // 已下线)。default 'low' 与原行为对齐，用户也可选完整 Codex effort 档位。
    modelReasoningEffort: settingsStore.get('summaryReasoning') ?? 'low',
    // plan prancy-forging-penguin:codex summary model 改读统一字段 settings.summaryModel
    // (不再是 codexSummaryModel — 已下线 + REMOVED_KEYS 清孤儿)。优先级链:
    //   settings.summaryModel > CODEX_SUMMARY_MODEL env > undefined (fallback config.toml)
    // user 责任:provider=codex 时 settings.summaryModel 填的 model id 必须 codex SDK 可用。
    // 填其他 provider 的 alias 会撞 codex SDK 不识别报错并走 caller fallback。
    model:
      settingsStore.get('summaryModel') ||
      process.env.CODEX_SUMMARY_MODEL ||
      undefined,
    // R37 P2-H：runner 自己内置 timeout（同 claude path 走 settings.summaryTimeoutMs；
    // 原 caller summarizer/index.ts 起 Promise.race 已删除）。timer 先赢 → 抛
    // `__codex_summarizer_timeout__` 让 caller catch 走 fallback 路径。
    timeoutMs: settingsStore.get('summaryTimeoutMs'),
    timeoutErrorMessage: '__codex_summarizer_timeout__',
  });

  return cleanCompactResult(result, 120);
}
