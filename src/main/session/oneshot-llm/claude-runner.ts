/**
 * Claude SDK oneshot runner（R37 P2-H Step 3.2）— 跑一次 SDK query + consume + race。
 *
 * **抽出动机**（reviewer 双对抗 R1 H4 finding）：
 * 收口 Claude-family 周期总结的 SDK query / consume / timeout 机制：
 *   - loadSdk + getSdkRuntimeOptions + getPathToClaudeCodeExecutable 同款 3 行
 *   - sdk.query 8+ option 同款（permissionMode / settingSources / executable / env / pathToClaudeCodeExecutable）
 *   - consumeLoop async iter（拼 assistant text + 收到 result 立刻 break 让 cli.js 退出）
 *   - race 模板（q.interrupt onTimeout + setTimeout reject + try/finally clearTimeout）
 *
 * caller 仅需传模型 / effort / prompt / systemPrompt / timeout / errorMessage。
 *
 * **不变量**：
 * - permissionMode: 'dontAsk' + tools=[] + mcpServers={}：不暴露可执行工具
 * - settingSources: []：不读 ~/.claude/settings.json，避免 hook 回环到自己
 * - cwd: 每次调用创建空临时目录，结束后清理，不让 summary provider 读取 session 工作区
 * - effort 有配置时透传 Claude Code SDK；undefined 时沿用 provider 默认
 * - 收到 type='result' 立刻 break，让 cli.js 子进程尽快退出（不等下个 message）
 * - executable + env + pathToClaudeCodeExecutable 走 sdk-runtime helper（解 Electron .app 启
 *   动 PATH 失 + asar 不 unpack 双重坑，详 sdk-runtime.ts）
 *
 * **不在本 helper 处理**：
 * - 模型优先级链（settings > env > alias）— caller 自己组装 + 传字符串 model 进来
 * - prompt 模板— caller 用 build-prompt.ts helper 组装
 * - result 清洗— caller 用 clean-result.ts helper 处理
 * - timeout error 字面— caller 传
 */
import { getSdkRuntimeOptions } from '@main/adapters/claude-code/sdk-runtime';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import { resolveClaudeBinary } from '@main/adapters/claude-code/resolve-claude-binary';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeThinkingLevel } from '@shared/session-metadata';
import { raceWithTimeout } from './race-with-timeout';

/**
 * 跑一次 claude SDK oneshot query，返回 LLM 原始拼接的 assistant text。
 *
 * @returns LLM 完整输出文本（未清洗）；race 输（timer 先 reject）→ throw `Error(timeoutErrorMessage)`
 */
export async function runClaudeOneshot(opts: {
  /** Session cwd，仅作为 prompt 中的只读标签；provider 实际运行在空临时目录。 */
  cwd: string;
  /** 完整 user prompt。caller 用 build-prompt.ts buildSummarizePrompt 组装。 */
  prompt: string;
  /** 模型 id（caller 已组装 settings > env > alias 优先级链，传最终字符串）。 */
  model?: string;
  /** Claude Code reasoning effort；undefined 时沿用 SDK/provider 默认。 */
  effort?: ClaudeThinkingLevel;
  /** systemPrompt（caller 从 build-prompt.ts CLAUDE_*_SYSTEM_PROMPT 常量取）。 */
  systemPrompt: string;
  /** Provider-specific env overlay; Deepseek uses this to set base URL/token/model without mutating process.env. */
  envOverride?: Readonly<Record<string, string>>;
  /** Timeout 毫秒；<= 0 不起 timer。 */
  timeoutMs: number;
  /** Timer 触发 reject 的 summary-specific errorMessage。 */
  timeoutErrorMessage: string;
  /** Optional caller-owned cancellation. */
  signal?: AbortSignal;
}): Promise<string> {
  const sdk = await loadSdk();
  const runtime = getSdkRuntimeOptions();
  // plan add-claude-cli-path-override-and-bump-sdks-20260520 §设计决策 D1 + §不变量 N5
  // + Follow-up F2+F3 抽 helper(plan §D5 + §D7 deviation):resolveClaudeBinary 内含 user
  // override priority chain + existsSync 护栏 + bundled fallback。详 resolve-claude-binary.ts。
  const claudeBinary = resolveClaudeBinary();

  const isolatedCwd = mkdtempSync(join(tmpdir(), 'agent-deck-periodic-summary-'));
  try {
    const q = sdk.query({
      prompt: opts.prompt,
      options: {
        cwd: isolatedCwd,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        permissionMode: 'dontAsk',
        systemPrompt: opts.systemPrompt,
        settingSources: [],
        tools: [],
        mcpServers: {},
        maxTurns: 1,
        // SDK 默认会 spawn 'node'，但 .app 走 launchd 启动时 PATH 不含 nvm/homebrew 的 node。
        // 用 Electron 二进制 + ELECTRON_RUN_AS_NODE=1 复用内置 Node runtime，零依赖系统 node。
        executable: runtime.executable,
        env: {
          ...runtime.env,
          ...(opts.envOverride ?? {}),
        },
        // SDK 0.2.x 把 cli.js 拆成 native binary（platform-specific 包），SDK 内部
        // require.resolve 拿到的路径在 .app 里走 `app.asar/...`，spawn 走系统 syscall
        // 不经 Electron fs patch → ENOTDIR → summarizer LLM 100% 失败 → 全降级到事件统计。
        // 显式传解析后的 unpacked 路径绕开 SDK 自带 K7。详见 sdk-runtime.ts。
        ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
      },
    });

    return await raceWithTimeout({
      work: consumeClaudeQuery(q),
      timeoutMs: opts.timeoutMs,
      errorMessage: opts.timeoutErrorMessage,
      // 优先优雅中断让 SDK 自己清子进程；interrupt 失败也无所谓（reject 抛错兜底）。
      onTimeout: () => {
        q.interrupt?.().catch(() => undefined);
      },
      signal: opts.signal,
      onAbort: () => {
        q.interrupt?.().catch(() => undefined);
      },
    });
  } finally {
    rmSync(isolatedCwd, { recursive: true, force: true });
  }
}

/**
 * Consume claude SDK query async iter：拼所有 assistant text 块，收到 type='result' 立刻 break。
 *
 * 早 break 关键：cli.js 子进程在收到 result 后还会发若干 metadata message，但应用层不
 * 需要——break 让 for-await 退 → q 析构 → cli.js 收 SIGTERM → 子进程 1-2s 内退（vs 等
 * 自然超时 10s+ 才退），降低 inFlight 槽占用时间。
 */
async function consumeClaudeQuery(
  q: AsyncIterable<unknown>,
): Promise<string> {
  let result = '';
  for await (const msg of q) {
    const m = msg as {
      type: string;
      message?: { content?: { type: string; text?: string }[] };
    };
    if (m.type === 'assistant' && m.message?.content) {
      for (const block of m.message.content) {
        if (block.type === 'text' && block.text) result += block.text;
      }
    }
    if (m.type === 'result') break;
  }
  return result;
}
