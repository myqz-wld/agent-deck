/**
 * MCP server 拼装 — Task Manager + Agent Deck MCP（CHANGELOG_85 Step 3.2）。
 *
 * 抽自 ClaudeSdkBridge.createSession 内 mcp 拼装段（原 ~35 行 inline 紧贴 query() 调用）。
 * 把两个 server 的 lazy provider 工厂 + console.log 提示统一收口，让 createSession 主体
 * 只关心拼装结果。
 *
 * 行为（保持原 createSession 拼装逻辑等价）：
 * - settings.enableTaskManager ON → 起 tasksServer，team_id 通过 lazy lookup
 *   （memberships 排序 + lead 优先），sessionId 用 internal.realSessionId 或 tempKey 兜底
 *   （tempKey 阶段 ingest 落到临时 cli 记录，realId 拿到后 renameSdkSession 迁子表）
 * - settings.enableAgentDeckMcp ON → 起 agentDeckMcpServer，callerSessionIdProvider
 *   走 lazy 工厂（每次 tool 调用时拿当前 SDK session id；tools.ts 内强制覆盖
 *   args.caller_session_id 防 prompt 注入）
 *
 * 两个 mcp server 是独立 toggle，可同开 / 同关 / 单挂。
 */

import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { settingsStore } from '@main/store/settings-store';
import { getTasksMcpServerForSession } from '@main/task-manager/server';
import { getAgentDeckMcpServerForSession } from '@main/agent-deck-mcp/server';
import type { InternalSession } from './types';

type McpServerConfig = Awaited<ReturnType<typeof getTasksMcpServerForSession>>;

/**
 * 起 tasksServer + agentDeckMcpServer（两者独立 toggle，可单可双）。
 *
 * lazy provider 设计：tasksServer 的 teamIdProvider / sessionIdProvider + agentDeck
 * 的 callerSessionIdProvider 都是 closure 函数，**每次 tool 调用时**才执行 → 拿到
 * 当前最新的 internal.realSessionId（首条 message 后才被赋值），且能反映会话期间
 * team membership 变化。
 *
 * @returns 两个 server config（null = 对应 toggle OFF），caller 自己拼到 query() options
 */
export async function buildMcpServersForSession(
  internal: InternalSession,
  tempKey: string,
): Promise<{
  tasksServer: McpServerConfig | null;
  agentDeckMcpServer: McpServerConfig | null;
}> {
  // R3.E8 / ADR §5.4：teamNameProvider → teamIdProvider。task-manager 写 tasks.team_id
  // 列（v011），不再依赖 sessions.team_name（v006 deprecated）。lazy lookup：
  // 反查 caller 当前所属 team；多 team 时取最近 join 的（lead role 优先）。
  const enableTaskManager = settingsStore.get('enableTaskManager') === true;
  const tasksServer = enableTaskManager
    ? await getTasksMcpServerForSession(
        () => {
          const sid = internal.realSessionId ?? tempKey;
          const memberships = agentDeckTeamRepo
            .findActiveMembershipsBySession(sid)
            .sort((a, b) => b.joinedAt - a.joinedAt);
          const lead = memberships.find((m) => m.role === 'lead');
          return (lead ?? memberships[0])?.teamId ?? null;
        },
        // CHANGELOG_<X> A3：sessionIdProvider 让 mcp tools.ts 写操作后能 ingest
        // team-task-* AgentEvent 到正确 sessionId 名下。tempKey 阶段 ingest 会
        // 落到 tempKey 这个不在 DB 的 sessionId（ensureRecord 会建一个临时 cli 记录），
        // realId 拿到后 sessionManager.renameSdkSession 会把子表迁移过来。
        () => internal.realSessionId ?? tempKey,
      )
    : null;
  if (tasksServer) {
    console.log('[task-manager] mcpServers attached for session (team_id lazy-resolved)');
  }

  // CHANGELOG_<X> R2 / B'3：Agent Deck MCP server in-process 注入。开关 ON 时给
  // claude 会话挂 in-process MCP，让 claude 能跨 adapter 编排其他 session
  // （spawn / send / list / get / shutdown / archive_plan / hand_off_session — CHANGELOG_100 7-tool set）。
  // callerSessionIdProvider 走 lazy 工厂，每次 tool 调用时拿当前 SDK session id —
  // tools.ts 内部强制覆盖 args.caller_session_id 防 prompt 注入伪造身份。
  // tempKey 阶段沿用 task-manager 同款宽容策略：caller 反查不到 sessionRepo 时不阻塞，
  // tools.ts validateExternalCaller 仅在 transport='in-process' 时跳过反查。
  const enableAgentDeckMcp = settingsStore.get('enableAgentDeckMcp') === true;
  const agentDeckMcpServer = enableAgentDeckMcp
    ? await getAgentDeckMcpServerForSession(() => internal.realSessionId ?? tempKey)
    : null;
  if (agentDeckMcpServer) {
    console.log('[agent-deck-mcp] in-process MCP attached for session');
  }

  return { tasksServer, agentDeckMcpServer };
}
