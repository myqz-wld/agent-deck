/**
 * Agent Deck MCP server 顶层入口（B'0 ADR §2 / §9）。
 *
 * 三 transport 共享同一份 buildAgentDeckTools 输出（tools.ts），但实例化路径不同：
 * - in-process（B'3）：用 SDK `createSdkMcpServer`，挂到 sdk-bridge query options.mcpServers
 * - HTTP（B'4）：用 mcp-sdk `McpServer` + `StreamableHTTPServerTransport`，
 *   挂到 fastify HookServer 的 `/mcp` route（rate-limit + Bearer token）
 * - stdio（B'1）：用 mcp-sdk `McpServer` + `StdioServerTransport`，
 *   通过 `agent-deck mcp` 子命令的子进程入口启动
 *
 * 调用者契约：
 * - in-process（per-session 实例化，与 task-manager getTasksMcpServerForSession 同模式）：
 *   `await getAgentDeckMcpServerForSession(callerSessionIdProvider)` → 挂 query.mcpServers
 * - HTTP（应用全局单例，跟 HookServer 一起启停）：
 *   `await registerAgentDeckMcpHttpRoutes(routeRegistry)` → fastify 自动挂 /mcp
 * - stdio（cli.ts 子进程子命令入口）：
 *   `await runAgentDeckMcpStdio()` → 接管当前进程 stdin/stdout
 */

import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import { buildAgentDeckTools } from './tools';

/**
 * 构造 in-process MCP server（B'3 在 sdk-bridge 内调，per-session 实例化）。
 *
 * `callerSessionIdProvider` lazy 工厂：每次 tool 调用时调一次拿当前 SDK session id，
 * 用于强制覆盖 args.caller_session_id（防 prompt 注入伪造身份）。与 task-manager
 * `getTasksMcpServerForSession` 同款 pattern（CHANGELOG_46 / CHANGELOG_<X> A3）。
 *
 * 与 task-manager server name 'tasks' 区分：本 server name = 'agent-deck'，对应
 * SDK pre-approve `mcp__agent_deck__*` 通配。
 */
export async function getAgentDeckMcpServerForSession(
  callerSessionIdProvider: () => string | null,
): Promise<McpSdkServerConfigWithInstance> {
  const { createSdkMcpServer } = await loadSdk();
  const tools = await buildAgentDeckTools({
    callerSessionIdOverride: callerSessionIdProvider,
    transport: 'in-process',
  });
  return createSdkMcpServer({
    name: 'agent-deck',
    version: '0.1.0',
    tools,
  });
}

/**
 * MCP allowedTools 通配（B'3 sdk-bridge query options 用）：
 * 与 'agent-deck' server name 对齐 → `mcp__agent_deck__*`
 */
export const AGENT_DECK_MCP_TOOL_PATTERN = 'mcp__agent_deck__*';
