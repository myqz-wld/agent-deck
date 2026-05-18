/**
 * Agent Deck MCP server 自动注入 codex 配置（B'0 ADR §9 / R1.A5 + R1.D7 + B'4）。
 *
 * 不写 ~/.codex/config.toml 持久化（避免污染用户配置）；改走 codex SDK `Codex({ config })`
 * 字段动态注入 — codex SDK 内部把 config object flatten 成 `--config key=value` CLI flag。
 *
 * 与 R1.A4b（用户在 Settings 面板手配的 codexMcpServers 持久化到 ~/.codex/config.toml）
 * 是 **互补关系**：用户手写的 server 走 toml 持久化、codex 启动自动加载；agent-deck
 * 自管的 'agent-deck' server 走 SDK config 动态注入，下次重启 codex 时按当时 settings
 * 重新计算（无脏文件残留）。
 *
 * 注入条件（任一 false → 返回 null，不注入）：
 * - settings.enableAgentDeckMcp === true
 * - settings.mcpHttpEnabled === true
 * - hookServer 已启动（拿到 listeningPort + mcpBearerToken）
 *
 * Token 通过 env var `AGENT_DECK_MCP_TOKEN` 间接引用 — codex CLI 子进程 readEnv 拿到 token
 * 拼 HTTP Authorization: Bearer header。**plan codex-handoff-team-alignment-20260518 P2 / D1
 * ADR token 共存策略**：env 来源双轨道：
 * - **per-session 路径**（应用 spawn 的 codex teammate live session）：sdk-bridge
 *   ensureCodex 内 `new Codex({env: {...snapshotProcessEnv(), AGENT_DECK_MCP_TOKEN: <session-token>}})`
 *   把 per-session token 注入子进程 envOverride（codex SDK 0.120.0 spec 确认 envOverride frozen
 *   拷贝到子进程 env，spike 2 §1 实证）。HookServer.checkMcpAuth 反查 mcpSessionTokenMap.get(token)
 *   命中 sid → handler 拿到真实 caller_session_id
 * - **全局 fallback 路径**（外部 codex CLI / 非应用 spawn）：子进程继承主进程 process.env，
 *   读到全局 `AGENT_DECK_MCP_TOKEN`（main bootstrap 一次性设）。HookServer.checkMcpAuth 反查
 *   mcpSessionTokenMap 不命中 → 比对全局 token 命中 → fallbackToGlobal=true → handler 视为
 *   external caller（EXTERNAL_CALLER_ALLOWED 表只允许 list/get）
 *
 * 为什么不直接 inline `bearer_token = "<literal>"`：
 * - codex 配置审计 / 调试时 cat config.toml 看不到明文 token（虽然这里走 --config
 *   inline，理论上 ps -ef 能看到，但更难被偶然抓走）
 * - 与 codex 文档推荐用法一致（用户手配 mcp_servers http 时也用 env var 引用）
 *
 * **plan P2 Step 2.6 修订**：删 `setAgentDeckMcpTokenEnv()` setter — 全局 token 在 main
 * bootstrap 启动时一次性设到 process.env（详 D1 §(c)），运行时不再 mutate。让 main bootstrap
 * 直接 inline `process.env[AGENT_DECK_MCP_TOKEN_ENV] = token`，移除多余抽象层。
 */

import type { AppSettings } from '@shared/types';
import type { HookServer } from '@main/hook-server/server';

/**
 * codex SDK 接受任意 toml-friendly object（codex SDK CodexOptions.config 类型签名）。
 * 我们手定一个最小子集即可，不依赖 SDK 内部 type alias（@openai/codex-sdk 未 export
 * CodexConfigObject 类型）。
 */
type CodexConfigValue = string | number | boolean | CodexConfigValue[] | CodexConfigObject;
export interface CodexConfigObject {
  [key: string]: CodexConfigValue;
}

export const AGENT_DECK_MCP_TOKEN_ENV = 'AGENT_DECK_MCP_TOKEN';
export const AGENT_DECK_MCP_SERVER_NAME = 'agent-deck';

/**
 * 计算 codex SDK Codex({ config }) 字段中要注入的 mcp_servers.agent-deck 段。
 * 不满足注入条件 → 返回 null（与现有 codex 入口的「不传 config」语义对齐）。
 */
export function buildAgentDeckMcpConfigForCodex(
  settings: Pick<AppSettings, 'enableAgentDeckMcp' | 'mcpHttpEnabled'>,
  hookServer: Pick<HookServer, 'isRunning' | 'listeningPort' | 'mcpBearerToken'> | null,
): CodexConfigObject | null {
  if (!settings.enableAgentDeckMcp) return null;
  if (!settings.mcpHttpEnabled) return null;
  if (!hookServer || !hookServer.isRunning) return null;
  if (!hookServer.mcpBearerToken) return null;

  return {
    mcp_servers: {
      [AGENT_DECK_MCP_SERVER_NAME]: {
        url: `http://127.0.0.1:${hookServer.listeningPort}/mcp`,
        bearer_token_env_var: AGENT_DECK_MCP_TOKEN_ENV,
      },
    },
  };
}

/**
 * 合并 buildAgentDeckMcpConfigForCodex 输出与用户已有的 SDK config（如未来扩展）。
 * 当前仅是单一来源，但保留合并函数便于 R1 后续叠加更多 codex SDK config 字段。
 *
 * 合并策略：浅 merge mcp_servers 段，agent-deck 名固定不会与用户手配冲突
 *（用户在 Settings UI 编辑 codexMcpServers 时 Settings 应该禁用 'agent-deck' 名 reserved）。
 */
export function mergeCodexConfig(
  existing: CodexConfigObject | null,
  override: CodexConfigObject | null,
): CodexConfigObject | null {
  if (!existing && !override) return null;
  if (!existing) return override;
  if (!override) return existing;
  const merged: CodexConfigObject = { ...existing };
  for (const [key, val] of Object.entries(override)) {
    const existingVal = merged[key];
    if (
      existingVal &&
      typeof existingVal === 'object' &&
      !Array.isArray(existingVal) &&
      val &&
      typeof val === 'object' &&
      !Array.isArray(val)
    ) {
      // 一层嵌套 merge（如 mcp_servers.agent-deck 与 mcp_servers.user-thing）
      merged[key] = { ...existingVal, ...val } as CodexConfigObject;
    } else {
      merged[key] = val;
    }
  }
  return merged;
}
