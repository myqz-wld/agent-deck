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
 * - in-process（B'3，per-session 实例化）：
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
 * 用于强制覆盖 args.callerSessionId（防 prompt 注入伪造身份）。
 *
 * **server name = 'agent-deck'**：对应 SDK pre-approve `mcp__agent-deck__*` 通配
 * （**注意 hyphen 不是 underscore**：MCP 协议 `mcp__<server-name>__<tool-name>` 中
 * server-name 含连字符就照搬，不会做 hyphen→underscore 重写。R1 deep review HIGH-1
 * 发现历史 pattern 用 underscore = 与 server name 'agent-deck' 不匹配 → SDK fnmatch
 * 永远命中不上 → allowedTools 实际不生效。Phase A3 修：pattern 与 name 对齐用 hyphen）。
 *
 * **plan task-mcp-merge-into-agent-deck-mcp-20260521**：原独立 tasks server 已合并入 agent-deck
 * namespace，5 个 task tool（task_create / task_list / task_get / task_update / task_delete）
 * 通过本 server 暴露（工具名 mcp__agent-deck__task_*）。删 task-manager/ 独立模块 + 删
 * enableTaskManager 独立 toggle，task tools 跟随 enableAgentDeckMcp 开关。
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
 * 与 'agent-deck' server name 对齐 → `mcp__agent-deck__*`（hyphen 与 server name 一致；
 * 详 getAgentDeckMcpServerForSession 注释 R1 HIGH-1 / Phase A3）。
 */
export const AGENT_DECK_MCP_TOOL_PATTERN = 'mcp__agent-deck__*';
