/**
 * `resolveBundledClaudeBinary()`：返回打包后内置 claude SDK CLI 二进制的绝对路径
 * （plan codex-handoff-team-alignment-20260518 §P3 Step 3.5 + v4 M7）。
 *
 * 与 `resolveBundledCodexBinary()`（codex-cli/sdk-bridge/codex-binary.ts）字面对称：
 * - 返 `string | null`：找到 → 绝对路径；找不到 → null
 * - 不抛错（fs check 失败时返 null 让 caller fallback）
 *
 * **使用场景**：codex-cli adapter spawn reviewer-claude wrapper teammate 时，
 * `options-builder.ts narrowToCodexOpts` 按 `agentName === 'reviewer-claude'` 触发
 * `envOverrideExtra: { AGENT_DECK_CLAUDE_PATH: resolveBundledClaudeBinary() }` 注入
 * codex 子进程 env，wrapper 内嵌 Bash 模板 `$AGENT_DECK_CLAUDE_PATH -p < input.txt`
 * 用此 env var 引用 bundled claude binary（不 hardcode 路径）。
 *
 * **dev / packaged 双路径**（委托给 `getPathToClaudeCodeExecutable`，已有完整分流逻辑）：
 * - dev：`require.resolve('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude')` 命中真实
 *   `node_modules/.../claude` 路径，wrapper Bash 直接可执行
 * - packaged：`require.resolve` 命中 `app.asar/.../claude` → replace `app.asar` →
 *   `app.asar.unpacked` 段，spawn 时 OS posix_spawn 走真实文件路径不撞 ENOTDIR
 *
 * 与 `resolveBundledCodexBinary` 行为差：
 * - codex helper：`if (!app.isPackaged) return null`（dev 让 SDK 走自己 resolve）
 * - 本 helper：dev 也返非 null（require.resolve 真路径）—— 让 codex sandbox 内 wrapper Bash
 *   `$AGENT_DECK_CLAUDE_PATH` 在 dev / packaged 双环境都直接可用，不需 caller 分流
 *
 * @returns string | null：找到时绝对路径，未找到（require.resolve 失败 / OS 不在 candidate
 *   list）时 null
 */
import { getPathToClaudeCodeExecutable } from './sdk-runtime';

export function resolveBundledClaudeBinary(): string | null {
  return getPathToClaudeCodeExecutable() ?? null;
}
