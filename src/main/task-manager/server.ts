/**
 * Task Manager 顶层入口（CHANGELOG_43 升级 / 来自 CHANGELOG_42 地基）：组装 5 个
 * in-process MCP tools 成一个 `tasks` server，给 sdk-bridge 在每次 query() 之前
 * 按需挂到 mcpServers 字段。
 *
 * **per-session 实例化**（CHANGELOG_43 改）：从 CHANGELOG_42 的全局单例
 * `getTaskMcpServer()` 改为 `getTasksMcpServerForSession(teamName)`，每个 SDK
 * 会话用自己的 teamName 闭包构造一份独立 server instance。原因：
 *
 * 1. **闭包注入 team_name**：tools.ts 的 task_create / task_update / task_delete
 *    强制用 closure 的 teamName，agent 不必（也不能）瞎传，避免任务漂到别 team。
 *    每个 session 的 team_name 不同，server 不能共享。
 * 2. **避免 cross-session state pollution**：SDK 文档没明示 in-process MCP server
 *    instance 能否跨 session 复用。pending tool calls / RPC state 都是 instance
 *    内部状态，per-session 一份最稳。
 *
 * 调用方契约（sdk-bridge.ts query() options 之前）：
 * ```ts
 * const tasksServer = settings.enableTaskManager
 *   ? await getTasksMcpServerForSession(opts.teamName ?? null)
 *   : null;
 * query({ options: {
 *   ...(tasksServer ? { mcpServers: { tasks: tasksServer }, allowedTools: ['mcp__tasks__*'] } : {}),
 *   // ...
 * }});
 * ```
 *
 * 注意必须在 `initDb()` 已经跑过的进程里使用——agent-deck 主进程启动时 `initDb()`
 * 在 SDK 任何会话起来之前就 init 过了，运行时无感。
 */
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { taskRepo } from '@main/store/task-repo';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import { buildTaskTools } from './tools';

export async function getTasksMcpServerForSession(
  teamName: string | null,
): Promise<McpSdkServerConfigWithInstance> {
  const { createSdkMcpServer } = await loadSdk();
  const tools = await buildTaskTools(taskRepo, teamName);
  return createSdkMcpServer({
    name: 'tasks',
    version: '1.0.0',
    tools,
  });
}
