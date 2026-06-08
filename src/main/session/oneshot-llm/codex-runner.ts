/**
 * Codex SDK oneshot runner（R37 P2-H Step 3.2）— 跑一次 codex thread.run + race。
 *
 * **抽出动机**（reviewer 双对抗 R1 H4 finding）：
 * `summariseCodexSessionViaOneshot` + `summariseCodexSessionForHandOff` 两路 codex SDK
 * oneshot 字面镜像 ~90%：
 *   - getCodexInstance 复用应用全局 codex 实例（R37 P1-G codex-instance-pool）
 *   - thread = codex.startThread(...) 共款 4 option（workingDirectory / sandboxMode='read-only'
 *     / approvalPolicy='never' / skipGitRepoCheck）
 *   - thread.run(prompt) → finalResponse
 *   - 可选 race（handoff 60s hardcoded；summarize 走 settings.summaryTimeoutMs）
 *
 * 仅 modelReasoningEffort（'low' summarize / 'medium' handoff）+ timeoutMs + errorMessage 3
 * 处差异。抽公共 helper 收口。
 *
 * **不变量**（与原 2 runner 一致）：
 * - sandboxMode='read-only'：禁 codex 真跑工具改文件
 * - approvalPolicy='never'：不等审批（read-only 下也无可审批，双保险）
 * - skipGitRepoCheck=true：跳 codex 默认 git repo 校验（任意 cwd 都能跑 oneshot）
 * - cwd: resolveSpawnCwd(opts) —— trim 后非空才用 caller cwd，否则降级 process.cwd()
 *   （R37 P3-C Step 4.1 抽 helper 收口前是宽松版 `opts.cwd || process.cwd()`，对正常调用零变化）
 *
 * **不在本 helper 处理**：
 * - prompt 模板（用 build-prompt.ts buildSummarizePrompt({agentName:'Agent'}) /
 *   buildHandoffPrompt({agentName:'Agent'}) 组装）
 * - finalResponse 清洗（用 clean-result.ts cleanCompactResult / cleanStructuredResult）
 * - errorMessage 字面（caller 传 `__codex_summarizer_timeout__` /
 *   `__codex_handoff_summary_timeout__`）
 *
 * **codex SDK 取消（REVIEW_82 MED 修法）**：raceWithTimeout onTimeout 调 `controller.abort()`，
 * 把 `{signal}` 传给 `thread.run(prompt, {signal})`（codex SDK TurnOptions.signal 支持，dist
 * 内 spawn 接到 child_process）→ timer reject 后 codex exec 子进程被取消，不再后台跑。与 claude
 * runClaudeOneshot q.interrupt() onTimeout 对称（防周期 summary timeout 累积后台进程）。
 *
 * **race scope**（REVIEW_37 R2 MED-1 修法）：包整个 oneshot 流程（getCodexInstance + startThread
 * + thread.run），而非只 thread.run。修前 SDK init 卡住时 caller inFlight 不释放（旧 caller 端
 * race 整个 promise 无此问题）。修后行为与 P2-H 抽 helper 前等价。
 */
import { getCodexInstance } from '@main/adapters/codex-cli/codex-instance-pool';
import { toCodexSdkModelOverride } from '@main/adapters/codex-cli/sdk-model';
import { resolveSpawnCwd } from '@main/utils/cwd-resolver';
import { raceWithTimeout } from './race-with-timeout';

/**
 * 跑一次 codex SDK oneshot thread.run，返回 finalResponse 原始文本。
 *
 * @returns codex 完整输出文本（未清洗）；race 输（timer 先 reject）→ throw `Error(timeoutErrorMessage)`
 */
export async function runCodexOneshot(opts: {
  /** Session cwd（trim 后空降级到 process.cwd() — 见 cwd-resolver.ts）。 */
  cwd: string;
  /** 完整 user prompt。caller 用 build-prompt.ts buildSummarizePrompt / buildHandoffPrompt 组装。 */
  prompt: string;
  /**
   * Reasoning effort：summarize 默认 'low'（30 字 tag-line 不需深思 + 出字快），handoff 默认
   * 'medium'（4 节结构化输出对理解力要求高，'low' 输出常常错位漏节，'high' 太慢 ~30s+）。
   *
   * plan prancy-forging-penguin: 扩到 4 档(minimal/low/medium/high)与 settings UI dropdown 对齐
   * (settings.summaryReasoning / handOffReasoning user 可选)。codex SDK 真支持 5 档含 'xhigh',
   * 未来如需暴露最高档再扩;当前 UI 4 档够用。
   */
  modelReasoningEffort: 'minimal' | 'low' | 'medium' | 'high';
  /**
   * prompt-asset-review-optimize-20260527 跟进:可选 model override 透传给 codex SDK
   * ThreadOptions.model(v0.131.0+ 支持 per-thread override)。caller 走 settings/env
   * 优先级链解析后传入;undefined → fallback `~/.codex/config.toml` 顶层 model 配置。
   */
  model?: string;
  /** Timeout 毫秒；<= 0 不起 timer。 */
  timeoutMs: number;
  /** Timer 触发 reject 的 errorMessage（caller 区分 summarize / handoff）。 */
  timeoutErrorMessage: string;
}): Promise<string> {
  // REVIEW_37 R2 MED-1 修法：timeout race 必须包整个 oneshot 流程（getCodexInstance +
  // startThread + thread.run），而非只 thread.run。修前 getCodexInstance / startThread 卡住
  // 时不受 timeout 保护 → caller 端 inFlight 不释放（旧 caller 端 race 整个
  // summariseCodexSessionViaOneshot promise）。修后行为与 R37 P2-H 抽 helper 前的 caller
  // 端 race 字面等价 — race scope 覆盖整个 SDK init + run 链路。
  //
  // **REVIEW_82 MED 修法（reviewer-codex 单方 + lead 验证 codex SDK signal 支持 + claude parity）**:
  // 修前注释误称「codex SDK 没 q.interrupt() 等价物 → race 输后 codex 子进程后台跑」— 实测
  // codex SDK `TurnOptions.signal: AbortSignal`（index.d.ts:171）+ `thread.run(input, {signal})`
  // （index.d.ts:209）支持取消，dist 内 `spawn(..., {signal})` 已接到 child_process。claude
  // runClaudeOneshot timeout 时调 q.interrupt() 取消子进程（claude-runner.ts:88-89），codex
  // 却放任后台跑 → 周期 summary timeout 连续发生时累积后台 codex exec 子进程 + 请求（资源泄漏）。
  // 修法：AbortController + thread.run(prompt, {signal}) + raceWithTimeout onTimeout abort，
  // 对齐 claude 取消语义（cross-adapter parity）。
  const controller = new AbortController();
  const work = (async () => {
    const codex = await getCodexInstance();
    const model = toCodexSdkModelOverride(opts.model);

    const thread = codex.startThread({
      workingDirectory: resolveSpawnCwd(opts),
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      modelReasoningEffort: opts.modelReasoningEffort,
      ...(model !== undefined ? { model } : {}),
    });

    return thread.run(opts.prompt, { signal: controller.signal });
  })();

  const result = await raceWithTimeout({
    work,
    timeoutMs: opts.timeoutMs,
    errorMessage: opts.timeoutErrorMessage,
    // timer 先赢 → abort signal 让 codex SDK 取消底层 exec 子进程（spawn 接到 signal）。
    // 与 claude runClaudeOneshot q.interrupt() onTimeout 对称，防周期 timeout 累积后台进程。
    onTimeout: () => controller.abort(),
  });

  return result.finalResponse;
}
