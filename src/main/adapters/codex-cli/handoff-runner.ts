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
 * - prompt 使用六节结构化压缩检查点模板（buildHandoffPrompt 而非 buildSummarizePrompt）
 * - `modelReasoningEffort` 读 settings.handOffReasoning（默认 medium；可选 minimal..ultra）
 * - 60s timeout hardcoded（与 claude hand-off 平齐，参考 llm-runners.ts:summariseSessionForHandOff）
 *   — 不读 settings.summaryTimeoutMs，因为 hand-off 与周期 summarize timeout 语义不同
 * - cleanStructuredResult 保留 \n 换行（六节检查点需分段渲染）；**不传 maxLen 不 slice**
 *   （REVIEW_37 R2 MED-1 修法：恢复 a748af1 旧版「不限长度」的有意 trade-off — codex
 *   handoff 六节检查点通常 800-2000 字但 outliers 可超 4K，slice 会切断结构节）
 *
 * **model**:prompt-asset-review-optimize-20260527 跟进 — codex SDK ThreadOptions.model 已支持
 * per-thread override(v0.131.0+),summariseCodexSessionForHandOff 走 settings.codexHandOffModel
 * 优先级链覆盖 codex CLI runtime model(对标 claude summariseSessionForHandOff 的
 * settings.handOffModel 优先级链)。
 *
 * **失败处理**与 claude 同：caller (IPC handler) 接到 throw 后透传 → renderer modal inline error
 * 让用户重试或手动编辑兜底 prompt。本 runner 内只做 timeout race + result 收集，不做 fallback。
 */
import type { AgentEvent } from '@shared/types';
import { settingsStore } from '@main/store/settings-store';
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
 * @returns 六节结构化压缩检查点；events 没有可总结内容 / codex 返回空 → null；
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
    // plan prancy-forging-penguin:reasoning 改读 settings.handOffReasoning(原 hardcoded
    // 'medium' 已下线)。default 'medium' 与原行为对齐 — hand-off 六节结构化检查点对 codex 理解力
    // 要求比 30 字 summarize 高；medium 是默认折中，用户也可选完整 Codex effort 档位。
    modelReasoningEffort: settingsStore.get('handOffReasoning') ?? 'medium',
    // plan prancy-forging-penguin:codex handoff model 改读统一字段 settings.handOffModel
    // (不再是 codexHandOffModel — 已下线 + REMOVED_KEYS 清孤儿)。优先级链:
    //   settings.handOffModel > CODEX_HANDOFF_MODEL env > undefined (fallback config.toml)
    // user 责任:provider=codex 时 settings.handOffModel 填的 model id 必须 codex SDK 可用
    // (典型为当前 provider 可用的中档 model id)。
    model:
      settingsStore.get('handOffModel') ||
      process.env.CODEX_HANDOFF_MODEL ||
      undefined,
    // 60s timeout：与 claude hand-off 平齐（llm-runners.ts:summariseSessionForHandOff），不读
    // settings.summaryTimeoutMs（hand-off 与周期 summarize timeout 语义不同）。timer 先赢 →
    // 抛 `__codex_handoff_summary_timeout__` 让 caller (ipc/sessions.ts) catch 透传到 renderer。
    timeoutMs: 60_000,
    timeoutErrorMessage: '__codex_handoff_summary_timeout__',
  });

  // 六节检查点保留 \n 换行让 textarea preview 直接渲染分段。
  // **不传 maxLen** — REVIEW_37 R2 MED-1 修法：恢复 a748af1 旧版「不限长度」的有意 trade-off
  // （codex hand-off 六节检查点通常 800-2000 字，slice 4000 会切断结构节）。详 clean-result.ts
  // cleanStructuredResult jsdoc 调用约束。
  return cleanStructuredResult(result);
}
