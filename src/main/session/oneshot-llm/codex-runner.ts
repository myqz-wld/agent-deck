/**
 * Codex app-server oneshot runner（R37 P2-H Step 3.2）— 跑一次 codex thread.run + race。
 *
 * **抽出动机**（reviewer 双对抗 R1 H4 finding）：
 * 收口 Codex 周期总结的 app-server thread / run / timeout 机制：
 *   - getCodexInstance 复用应用全局 codex app-server client（R37 P1-G codex-instance-pool）
 *   - thread = codex.startThread(...) 共款 4 option（workingDirectory / sandboxMode='read-only'
 *     / approvalPolicy='never' / skipGitRepoCheck）
 *   - thread.run(prompt) → finalResponse
 *   - timeout race 走 settings.summaryTimeoutMs
 *
 * **不变量**：
 * - sandboxMode='read-only'：禁 codex 真跑工具改文件
 * - approvalPolicy='never'：不等审批（read-only 下也无可审批，双保险）
 * - skipGitRepoCheck=true：跳 codex 默认 git repo 校验（任意 cwd 都能跑 oneshot）
 * - cwd: 每次调用创建空临时目录，结束后清理，不让 summary provider 读取 session 工作区
 * - base config / MCP / dynamic tools / network / writable dirs 均禁用，只消费调用方提供的证据
 *
 * **不在本 helper 处理**：
 * - prompt 模板（用 build-prompt.ts buildSummarizePrompt({agentName:'Agent'}) 组装）
 * - finalResponse 清洗（用 clean-result.ts cleanCompactResult）
 * - timeout error 字面
 *
 * **Codex 取消（REVIEW_82 MED 修法）**：raceWithTimeout onTimeout 调 `controller.abort()`，
 * 把 `{signal}` 传给 app-server `thread.run(...)` → timer reject 后 Codex turn 被取消，不再后台跑。与 claude
 * runClaudeOneshot q.interrupt() onTimeout 对称（防周期 summary timeout 累积后台进程）。
 *
 * **race scope**（REVIEW_37 R2 MED-1 修法）：包整个 oneshot 流程（getCodexInstance + startThread
 * + thread.run），而非只 thread.run。修前 SDK init 卡住时 caller inFlight 不释放（旧 caller 端
 * race 整个 promise 无此问题）。修后行为与 P2-H 抽 helper 前等价。
 */
import { getCodexInstance } from '@main/adapters/codex-cli/codex-instance-pool';
import { toCodexModelOverride } from '@main/adapters/codex-cli/sdk-model';
import { toCodexAppServerInput } from '@main/adapters/codex-cli/sdk-bridge/input-pack';
import { DISABLED_EXECUTABLE_FEATURES } from '@main/session/continuation-context/codex-isolation';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexThinkingLevel } from '@shared/session-metadata';
import { raceWithTimeout } from './race-with-timeout';
import { buildSummarizeSystemPrompt } from './build-prompt';

/**
 * 跑一次 codex app-server oneshot thread.run，返回 finalResponse 原始文本。
 *
 * @returns codex 完整输出文本（未清洗）；race 输（timer 先 reject）→ throw `Error(timeoutErrorMessage)`
 */
export async function runCodexOneshot(opts: {
  /** Session cwd，仅作为 prompt 中的只读标签；provider 实际运行在空临时目录。 */
  cwd: string;
  /** 完整 user prompt。caller 用 build-prompt.ts buildSummarizePrompt 组装。 */
  prompt: string;
  /** Highest-priority no-tool display-summary instruction. */
  systemPrompt?: string;
  /**
   * Reasoning effort for the periodic summary.
   * 与 settings UI 共用 CodexThinkingLevel：low / medium / high / xhigh / max / ultra。
   */
  modelReasoningEffort: CodexThinkingLevel;
  /**
   * prompt-asset-review-optimize-20260527 跟进:可选 model override 透传给 Codex
   * ThreadOptions.model。caller 走 settings/env
   * 优先级链解析后传入;undefined → fallback `~/.codex/config.toml` 顶层 model 配置。
   */
  model?: string;
  /** Timeout 毫秒；<= 0 不起 timer。 */
  timeoutMs: number;
  /** Timer 触发 reject 的 summary-specific errorMessage。 */
  timeoutErrorMessage: string;
}): Promise<string> {
  // REVIEW_37 R2 MED-1 修法：timeout race 必须包整个 oneshot 流程（getCodexInstance +
  // startThread + thread.run），而非只 thread.run。修前 getCodexInstance / startThread 卡住
  // 时不受 timeout 保护 → caller 端 inFlight 不释放（旧 caller 端 race 整个
  // summariseCodexSessionViaOneshot promise）。修后行为与 R37 P2-H 抽 helper 前的 caller
  // 端 race 字面等价 — race scope 覆盖整个 SDK init + run 链路。
  //
  // app-server run 接收 AbortSignal；timeout 先赢时 interrupt 当前 turn，对齐 claude 取消语义。
  const controller = new AbortController();
  const isolatedCwd = mkdtempSync(join(tmpdir(), 'agent-deck-periodic-summary-'));
  const work = (async () => {
    const codex = await getCodexInstance();
    const model = toCodexModelOverride(opts.model);

    const thread = codex.startThread({
      workingDirectory: isolatedCwd,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      modelReasoningEffort: opts.modelReasoningEffort,
      modelReasoningSummary: 'none',
      baseInstructions: opts.systemPrompt ?? buildSummarizeSystemPrompt('Agent'),
      configOverrides: {
        features: { ...DISABLED_EXECUTABLE_FEATURES },
        mcp_servers: {},
      },
      useBaseConfig: false,
      networkAccessEnabled: false,
      additionalDirectories: [],
      dynamicTools: [],
      environments: [],
      runtimeWorkspaceRoots: [],
      selectedCapabilityRoots: [],
      ephemeral: true,
      ...(model !== undefined ? { model } : {}),
    });

    return thread.run(toCodexAppServerInput(opts.prompt), { signal: controller.signal });
  })();

  try {
    const result = await raceWithTimeout({
      work,
      timeoutMs: opts.timeoutMs,
      errorMessage: opts.timeoutErrorMessage,
      // timer 先赢 → abort signal 让 Codex app-server 取消当前 turn。
      // 与 claude runClaudeOneshot q.interrupt() onTimeout 对称，防周期 timeout 累积后台进程。
      onTimeout: () => controller.abort(),
    });
    return result.finalResponse;
  } finally {
    rmSync(isolatedCwd, { recursive: true, force: true });
  }
}
