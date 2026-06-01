/**
 * Claude SDK 周期性 summarize + hand-off 简报两路 oneshot runner。
 *
 * **R37 P2-H Step 3.2 重构**：原 251 LOC（含 SDK 设置 / consume 循环 / race / 清洗 4 处共性
 * 镜像）下沉到 `@main/session/oneshot-llm/`：
 *   - SDK 设置 + consume 循环 → `runClaudeOneshot()`
 *   - race + timer → `raceWithTimeout()`
 *   - prompt body → `buildSummarizePrompt()` / `buildHandoffPrompt()`
 *   - result 清洗 → `cleanCompactResult()` / `cleanStructuredResult()`
 *   - systemPrompt → `CLAUDE_SUMMARIZE_SYSTEM_PROMPT` / `CLAUDE_HANDOFF_SYSTEM_PROMPT` 常量
 *
 * 本文件保留：
 *   - events → activity 文本（formatEventsForPrompt 复用）+ 空短路
 *   - 模型优先级链（settings > env > alias，summarize 用 haiku / handoff 用 sonnet）
 *   - timeout 来源（summarize 走 settings.summaryTimeoutMs / handoff 60s hardcoded）
 *   - errorMessage 字面（`__summarizer_timeout__` / `__handoff_summary_timeout__`）
 *
 * 行为零变化：测试（hand-off.test.ts 7 it）应继续全过。
 */
import type { AgentEvent } from '@shared/types';
import { settingsStore } from '@main/store/settings-store';
import {
  buildSummarizePrompt,
  buildHandoffPrompt,
  cleanCompactResult,
  cleanStructuredResult,
  runClaudeOneshot,
  CLAUDE_SUMMARIZE_SYSTEM_PROMPT,
  CLAUDE_HANDOFF_SYSTEM_PROMPT,
  type AgentName,
} from '@main/session/oneshot-llm';
import { formatEventsForPrompt } from './event-formatter';

/**
 * 用本地 OAuth + Claude Code SDK 跑一次 oneshot 总结。一句话（≤ 30 字）描述当前任务。
 *
 * **超时**：底层 cli.js 子进程因代理超时 / 鉴权死锁 / API 限流卡在等待 result 时，
 * for-await 会永远不返回 → inFlight 槽永不释放，maxConcurrent 个卡死后整个
 * Summarizer 不再产新总结。runClaudeOneshot 内部 raceWithTimeout 给硬上限：
 * - 优先调 q.interrupt() 让 SDK 自己优雅退（清掉 cli.js 子进程）
 * - 兜底 throw `__summarizer_timeout__`，让外层 catch 走兜底路径
 */
export async function summariseViaLlm(cwd: string, events: AgentEvent[]): Promise<string | null> {
  const activity = formatEventsForPrompt(events);
  if (!activity) return null;

  const result = await runClaudeOneshot({
    cwd,
    prompt: buildSummarizePrompt({ cwd, activity, agentName: 'Claude' }),
    // 总结只一句话，用 haiku 足够：成本低、吐字快，多个会话排队也不会卡。
    // 模型优先级（plan model-wiring-and-handoff-20260514 Step 4.3）：
    //   1. settings.summaryModel（UI 暴露的字符串字段，'' 表示沿用下面 env / alias 链）
    //   2. settings.json 里配的 ANTHROPIC_DEFAULT_HAIKU_MODEL（具体 id）
    //   3. ANTHROPIC_MODEL（用户主模型，没配 haiku 但配了主模型时退而求其次）
    //   4. 'haiku' alias（让什么都没配的环境也能跑，由 SDK / CLI 自己解析）
    // applyClaudeSettingsEnv 在 bootstrap 时已把 settings.json 的 env 注入 process.env。
    model:
      settingsStore.get('summaryModel') ||
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ||
      process.env.ANTHROPIC_MODEL ||
      'haiku',
    systemPrompt: CLAUDE_SUMMARIZE_SYSTEM_PROMPT,
    timeoutMs: settingsStore.get('summaryTimeoutMs'),
    timeoutErrorMessage: '__summarizer_timeout__',
  });

  return cleanCompactResult(result, 120);
}

/**
 * K3 hand-off 接力简报生成（plan mcp-bug-and-feature-batch-20260513 Phase 4c）。
 *
 * 与 `summariseViaLlm` 字面差异：
 * - 用 sonnet 模型（hand-off 是低频但要求结构化输出准确，haiku 偏弱）
 * - prompt 要求输出「目标 / 已做 / 下一步 / 相关文件」四节结构化
 * - 60s timeout（hardcoded，不读 settings.summaryTimeoutMs；hand-off 用 sonnet 慢需更长 budget）
 * - resultMaxLen 4000（允许更长接力简报，hand-off 不像 30 字 tag-line）
 *
 * 失败处理：caller (IPC handler) 接到 throw 后透传 → renderer modal inline error 让用户
 * 重试或手动编辑兜底 prompt。本函数内只做 timeout race + result 收集，不做 fallback。
 *
 * **agentName 参数化**（plan resume-inject-raw-messages-20260601 §D8）：默认 `'Claude'`
 * 向后兼容所有现有 caller（IPC hand-off / claude fallback）；codex jsonl-missing fallback
 * 复用本 claude oneshot（本地 OAuth，不为 codex 写平行总结函数 — 解开 REVIEW_60 F5 卡住的
 * 耦合）但传 `'Agent'`，否则 codex 会话摘要会自称「Claude 会话」（buildHandoffPrompt 的 intro
 * + 主体 `${a}` 替换按此分支）。marker label `[Claude 说]` 等保留字面（formatEventsForPrompt
 * 固定输出 label，不本地化）。
 */
export async function summariseSessionForHandOff(
  cwd: string,
  events: AgentEvent[],
  agentName: AgentName = 'Claude',
): Promise<string | null> {
  const activity = formatEventsForPrompt(events);
  if (!activity) return null;

  const result = await runClaudeOneshot({
    cwd,
    prompt: buildHandoffPrompt({ cwd, activity, agentName }),
    // hand-off 简报默认 sonnet(推翻 CHANGELOG_161 与 summary 对齐 haiku 的决策):
    // 4 节结构化简报对结构精度 / 上下文压缩质量敏感,sonnet 比 haiku 显著更稳。summary 仍 haiku
    // (短 tag-line 容错高、量大成本敏感),hand-off 不在该约束。user 想降 haiku 或升 opus/
    // thinking-max 自己在 settings.handOffModel 填 model id 即可。
    // 优先级链:
    //   1. settings.handOffModel(UI 暴露的字符串字段,'' 表示沿用下面 env / alias 链)
    //   2. ANTHROPIC_DEFAULT_SONNET_MODEL(settings.json 显式配的 sonnet id)
    //   3. ANTHROPIC_MODEL(用户主模型)
    //   4. 'sonnet' alias 兜底
    model:
      settingsStore.get('handOffModel') ||
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
      process.env.ANTHROPIC_MODEL ||
      'sonnet',
    systemPrompt: CLAUDE_HANDOFF_SYSTEM_PROMPT,
    // K3 单独的超时（不复用 summaryTimeoutMs—— hand-off 用 sonnet 慢，需要更长 budget）。
    // 60s 上限：sonnet + 200 events 通常 10-30s，60s 给 outliers 留余量。
    timeoutMs: 60_000,
    timeoutErrorMessage: '__handoff_summary_timeout__',
  });

  // 4 节简报允许较长（4000 字 ≈ 1500 token，足够 4 节展开）；保留 \n 换行让 textarea preview 直接渲染分段。
  return cleanStructuredResult(result, 4000);
}
