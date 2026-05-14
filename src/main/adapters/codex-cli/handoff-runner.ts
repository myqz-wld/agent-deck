/**
 * Codex hand-off 接力简报 runner（plan model-wiring-and-handoff-20260514 Step 5.1
 * + R37 P2-H Step 3.2 重构）。
 *
 * **R37 P2-H 重构**：原 129 LOC（含 codex SDK 设置 / startThread / thread.run / race / prompt 字面）
 * 下沉到 `@main/session/oneshot-llm/`：
 *   - codex SDK 设置 + thread.run + race → `runCodexOneshot()`
 *   - prompt body → `buildHandoffPrompt({agentName: 'Agent'})`
 *   - result 清洗 → `cleanStructuredResult()`
 *
 * 镜像 `summariseSessionForHandOff`（src/main/session/summarizer/llm-runners.ts）但走 codex
 * SDK 自身 — 让 codex session 的 hand-off 简报由 codex 自己出，不再借用 claude SDK + sonnet。
 *
 * 与 `summarizer-runner.ts:summariseCodexSessionViaOneshot` 差异：
 * - prompt 改 4 节结构化模板（buildHandoffPrompt 而非 buildSummarizePrompt）
 * - `modelReasoningEffort: 'medium'`（hand-off 比 summarize 'low' 提一档保结构精度；high 太
 *   慢、low 结构化输出精度不够，medium 折中）
 * - 60s timeout hardcoded（与 claude hand-off 平齐，参考 llm-runners.ts:summariseSessionForHandOff）
 *   — 不读 settings.summaryTimeoutMs，因为 hand-off 与周期 summarize timeout 语义不同
 * - cleanStructuredResult 保留 \n 换行（4 节简报需分段渲染）+ slice 4000
 *
 * **model 不显式传** — codex SDK startThread API 不接受 per-thread model override（runtime
 * model 由 ~/.codex/config.toml 顶层 `model` 决定）；plan D4 已说明，settings.handOffModel
 * 对 codex 路径无影响（仅对 claude session 生效）。
 *
 * **失败处理**与 claude 同：caller (IPC handler) 接到 throw 后透传 → renderer modal inline error
 * 让用户重试或手动编辑兜底 prompt。本 runner 内只做 timeout race + result 收集，不做 fallback。
 */
import type { AgentEvent } from '@shared/types';
import {
  buildHandoffPrompt,
  cleanStructuredResult,
  runCodexOneshot,
} from '@main/session/oneshot-llm';

/**
 * 跑一次 codex hand-off 简报。`formatEvents` 由 ipc/sessions.ts 注入（与 summarizer 路径同款，
 * 避免在本 runner 重复维护 events → prompt 序列化逻辑 —— summarizer/index.ts 已有
 * formatEventsForPrompt 函数措辞精细）。
 *
 * @returns 4 节结构化简报；events 没有可总结内容 / codex 返回空 → null；
 *          timer 先赢 / codex 进程错 → throw
 */
export async function summariseCodexSessionForHandOff(
  cwd: string,
  events: AgentEvent[],
  formatEvents: (events: AgentEvent[]) => string,
): Promise<string | null> {
  const activity = formatEvents(events);
  if (!activity) return null;

  const result = await runCodexOneshot({
    cwd,
    // agentName='Agent' — codex 不是 Claude；marker `[Claude 说]` 等保留是 formatEventsForPrompt
    // 固定 label，不本地化（与 summarizer-runner.ts 同款约定）。
    prompt: buildHandoffPrompt({ cwd, activity, agentName: 'Agent' }),
    // **modelReasoningEffort 提到 'medium'**：hand-off 4 节结构化输出对 codex 理解力要求比
    // 30 字 summarize 高；high 太慢（spike 实测 30s+），low 输出结构常常错位（漏节 / 节标题
    // 写错），medium 是 spike-A3 实测下的最佳折中。
    modelReasoningEffort: 'medium',
    // 60s timeout：与 claude hand-off 平齐（llm-runners.ts:summariseSessionForHandOff），不读
    // settings.summaryTimeoutMs（hand-off 与周期 summarize timeout 语义不同）。timer 先赢 →
    // 抛 `__codex_handoff_summary_timeout__` 让 caller (ipc/sessions.ts) catch 透传到 renderer。
    timeoutMs: 60_000,
    timeoutErrorMessage: '__codex_handoff_summary_timeout__',
  });

  // 4 节简报保留 \n 换行让 textarea preview 直接渲染分段，slice 4000 防超长。
  return cleanStructuredResult(result, 4000);
}
