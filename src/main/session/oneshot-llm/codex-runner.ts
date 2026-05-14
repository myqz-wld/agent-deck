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
 * - cwd: opts.cwd || process.cwd()：cwd 为空降级到主进程 cwd
 *
 * **不在本 helper 处理**：
 * - prompt 模板（用 build-prompt.ts buildSummarizePrompt({agentName:'Agent'}) /
 *   buildHandoffPrompt({agentName:'Agent'}) 组装）
 * - finalResponse 清洗（用 clean-result.ts cleanCompactResult / cleanStructuredResult）
 * - errorMessage 字面（caller 传 `__codex_summarizer_timeout__` /
 *   `__codex_handoff_summary_timeout__`）
 *
 * **codex SDK 没 q.interrupt() 等价物**：raceWithTimeout 不传 onTimeout，timer reject 后 codex
 * 子进程仍后台跑，最终被 codex SDK 进程退出回收（对 hand-off / summarize 一次性触发场景无副作用）。
 *
 * **race scope**（REVIEW_37 R2 MED-1 修法）：包整个 oneshot 流程（getCodexInstance + startThread
 * + thread.run），而非只 thread.run。修前 SDK init 卡住时 caller inFlight 不释放（旧 caller 端
 * race 整个 promise 无此问题）。修后行为与 P2-H 抽 helper 前等价。
 */
import { getCodexInstance } from '@main/adapters/codex-cli/codex-instance-pool';
import { raceWithTimeout } from './race-with-timeout';

/**
 * 跑一次 codex SDK oneshot thread.run，返回 finalResponse 原始文本。
 *
 * @returns codex 完整输出文本（未清洗）；race 输（timer 先 reject）→ throw `Error(timeoutErrorMessage)`
 */
export async function runCodexOneshot(opts: {
  /** Session cwd（空字符串降级到 process.cwd()）。 */
  cwd: string;
  /** 完整 user prompt。caller 用 build-prompt.ts buildSummarizePrompt / buildHandoffPrompt 组装。 */
  prompt: string;
  /**
   * Reasoning effort：summarize 用 'low'（30 字 tag-line 不需深思 + 出字快），handoff 用
   * 'medium'（4 节结构化输出对理解力要求高，'low' 输出常常错位漏节，'high' 太慢 ~30s+）。
   */
  modelReasoningEffort: 'low' | 'medium' | 'high';
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
  // codex SDK 没 q.interrupt() 等价物 — race 输 → codex 子进程仍后台跑 → 等 codex SDK 进
  // 程退出回收（一次性 oneshot 触发场景不影响 inFlight，应用层 finally 已 .delete(s.id)）。
  const work = (async () => {
    const codex = await getCodexInstance();

    const thread = codex.startThread({
      workingDirectory: opts.cwd || process.cwd(),
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      modelReasoningEffort: opts.modelReasoningEffort,
    });

    return thread.run(opts.prompt);
  })();

  const result = await raceWithTimeout({
    work,
    timeoutMs: opts.timeoutMs,
    errorMessage: opts.timeoutErrorMessage,
  });

  return result.finalResponse;
}
