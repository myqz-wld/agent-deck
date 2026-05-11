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
 * Token 通过 env var `AGENT_DECK_MCP_TOKEN` 间接引用（codex 子进程继承主进程 env 自动拿到）：
 * - bearer_token_env_var = 'AGENT_DECK_MCP_TOKEN'
 * - 主进程 bootstrap 在启动时调 setAgentDeckMcpTokenEnv 把 token 设到 process.env
 *
 * 为什么不直接 inline `bearer_token = "<literal>"`：
 * - codex 配置审计 / 调试时 cat config.toml 看不到明文 token（虽然这里走 --config
 *   inline，理论上 ps -ef 能看到，但更难被偶然抓走）
 * - 与 codex 文档推荐用法一致（用户手配 mcp_servers http 时也用 env var 引用）
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
 * 把 mcpServerToken 设进当前主进程 env，让 codex 子进程继承后能 readEnv(AGENT_DECK_MCP_TOKEN_ENV)
 * 拿到。codex SDK 默认透传主进程 env（除非显式传 env: {} 字段，本应用不传）。
 *
 * 注意：codex 子进程的 sandbox 模式（read-only / workspace-write）只限文件系统 + 网络，
 * 不限制 env 读取，所以 readEnv 在所有档位都可用。
 *
 * 调用时机：main bootstrap 在 settings 加载完后调一次（让首个 codex 会话启动前 env 已就绪）；
 * 用户在 Settings 改 mcpServerToken（理论上不应改，仅泄漏轮换时手动清除）后重启应用即可
 * （不做 hot-toggle —— mcpServerToken 是首次启动随机生成的，几乎不该变）。
 */
export function setAgentDeckMcpTokenEnv(token: string | null): void {
  if (token && token.length > 0) {
    process.env[AGENT_DECK_MCP_TOKEN_ENV] = token;
  } else {
    delete process.env[AGENT_DECK_MCP_TOKEN_ENV];
  }
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
