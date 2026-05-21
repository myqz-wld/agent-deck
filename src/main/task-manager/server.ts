/**
 * Task Manager 顶层入口（plan task-mcp-owner-session-id-rewrite-20260521 v023）：
 * 组装 5 个 in-process MCP tools 成一个 `tasks` server，给 sdk-bridge 在每次
 * query() 之前按需挂到 mcpServers 字段。
 *
 * **per-session 实例化**：每个 SDK 会话用自己的 sessionIdProvider 闭包构造一份
 * 独立 server instance。
 *
 * **v023 重设计签名**：删 teamIdProvider（task 不绑 team，team scope 在 query
 * 层 reverse join 算）；sessionIdProvider 改必填（task_create owner /
 * task_list/update/delete 写权限校验 都强依赖 caller sid）。
 *
 * 调用方契约（sdk-bridge.ts query() options 之前）：
 * ```ts
 * const tasksServer = settings.enableTaskManager
 *   ? await getTasksMcpServerForSession(() => internal.applicationSid)
 *   : null;
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
  sessionIdProvider: () => string | null,
): Promise<McpSdkServerConfigWithInstance> {
  const { createSdkMcpServer } = await loadSdk();
  const tools = await buildTaskTools(taskRepo, sessionIdProvider);
  return createSdkMcpServer({
    name: 'tasks',
    version: '1.0.0',
    tools,
  });
}
