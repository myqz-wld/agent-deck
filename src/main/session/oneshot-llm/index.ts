/**
 * `oneshot-llm/` — 4 个 LLM oneshot runner 共性收口（R37 P2-H Step 3.2）。
 *
 * **抽出动机**（reviewer 双对抗 R1 H4 finding）：
 * `summariseViaLlm` / `summariseSessionForHandOff` / `summariseCodexSessionViaOneshot` /
 * `summariseCodexSessionForHandOff` 4 个 runner 各自维护一套 race + result clean + prompt
 * template，其中：
 *   - prompt template 4 份字面镜像 95%（仅 agent 身份 + intro + 1 句澄清差异）
 *   - race 模板 4 份字面镜像 100%（仅 errorMessage / onTimeout 差异）
 *   - result clean 4 份分两种模式（compact tag-line / structured 4-section）
 *   - claude SDK 设置 2 份镜像 95%（仅模型 / prompt / systemPrompt 差异）
 *   - codex SDK 设置 2 份镜像 95%（仅 reasoning effort 差异）
 *
 * 重构后 4 runner 各自只剩 ~25 行（caller 装配 model 优先级 / prompt body / clean 策略 / errorMessage），
 * 共性 ~190 LOC 收口到本目录。
 *
 * **公共 API**：
 * - `buildSummarizePrompt({cwd, activity, agentName})` / `buildHandoffPrompt({cwd, activity, agentName})`
 * - `buildSummarizeSystemPrompt(agentName)` / `buildHandoffSystemPrompt(agentName)`
 * - `cleanCompactResult(raw, maxLen)` / `cleanStructuredResult(raw, maxLen)`
 * - `runClaudeOneshot({...})` / `runCodexOneshot({...})`
 * - `raceWithTimeout({...})`（2 runner 内部已封装；caller 需自定 race 时再直接使用）
 * - `AgentName` type
 */
export type { AgentName } from './build-prompt';
export {
  buildSummarizePrompt,
  buildHandoffPrompt,
  buildSummarizeSystemPrompt,
  buildHandoffSystemPrompt,
} from './build-prompt';
export { cleanCompactResult, cleanStructuredResult } from './clean-result';
export { raceWithTimeout } from './race-with-timeout';
export { runClaudeOneshot } from './claude-runner';
export { runCodexOneshot } from './codex-runner';
