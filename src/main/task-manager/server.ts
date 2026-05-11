/**
 * Task Manager 顶层入口（CHANGELOG_43 + R3.E8 task-manager teamId 迁移）：组装 5 个
 * in-process MCP tools 成一个 `tasks` server，给 sdk-bridge 在每次 query() 之前
 * 按需挂到 mcpServers 字段。
 *
 * **per-session 实例化**：每个 SDK 会话用自己的 teamIdProvider 闭包构造一份独立
 * server instance。
 *
 * **R3.E8 改 teamIdProvider**：原 teamNameProvider 走 sessions.team_name (v006 deprecated)，
 * 重名 team 场景歧义、universal-team 重写后语义全错（reviewer codex HIGH-3 修法）。
 * 新 teamIdProvider 走 agent_deck_team_members 反查，task 写入 tasks.team_id (v011)。
 *
 * **CHANGELOG_<X> A3 加 sessionIdProvider**：mcp 写操作（create / update→completed）
 * 后调 sessionManager.ingest 写一条 team-task-* AgentEvent 到 events 表。
 *
 * 调用方契约（sdk-bridge.ts query() options 之前）：
 * ```ts
 * const tasksServer = settings.enableTaskManager
 *   ? await getTasksMcpServerForSession(
 *       () => agentDeckTeamRepo.findActiveMembershipsBySession(sid)[0]?.teamId ?? null,
 *       () => sid,
 *     )
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
  teamIdProvider: () => string | null,
  sessionIdProvider?: () => string | null,
): Promise<McpSdkServerConfigWithInstance> {
  const { createSdkMcpServer } = await loadSdk();
  const tools = await buildTaskTools(taskRepo, teamIdProvider, sessionIdProvider);
  return createSdkMcpServer({
    name: 'tasks',
    version: '1.0.0',
    tools,
  });
}
