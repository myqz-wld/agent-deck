/**
 * Task Manager 顶层入口（CHANGELOG_43 升级 / 来自 CHANGELOG_42 地基）：组装 5 个
 * in-process MCP tools 成一个 `tasks` server，给 sdk-bridge 在每次 query() 之前
 * 按需挂到 mcpServers 字段。
 *
 * **per-session 实例化**（CHANGELOG_43 改）：从 CHANGELOG_42 的全局单例
 * `getTaskMcpServer()` 改为 `getTasksMcpServerForSession(teamNameProvider)`，每个 SDK
 * 会话用自己的 teamName 闭包构造一份独立 server instance。
 *
 * **CHANGELOG_46 改 lazy provider**：原来第二参数是 `string | null` 由 createSession
 * 入口固化。现在 createSession 入口不再知道 team 名（NewSessionDialog 删了 teamName
 * 输入框，team 由 lead 在会话内自由建，应用通过 team-coordinator 反向同步到 sessionRepo）。
 * 改成 `() => string | null` lazy 工厂，每次工具调用时调一次拿最新值。
 *
 * 调用方契约（sdk-bridge.ts query() options 之前）：
 * ```ts
 * const tasksServer = settings.enableTaskManager
 *   ? await getTasksMcpServerForSession(() => sessionRepo.get(sid)?.teamName ?? null)
 *   : null;
 * query({ options: {
 *   ...(tasksServer ? { mcpServers: { tasks: tasksServer }, allowedTools: ['mcp__tasks__*'] } : {}),
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
  teamNameProvider: () => string | null,
): Promise<McpSdkServerConfigWithInstance> {
  const { createSdkMcpServer } = await loadSdk();
  const tools = await buildTaskTools(taskRepo, teamNameProvider);
  return createSdkMcpServer({
    name: 'tasks',
    version: '1.0.0',
    tools,
  });
}
