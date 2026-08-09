/**
 * MCP server builder for Claude SDK sessions.
 *
 * Behavior:
 * - settings.enableAgentDeckMcp ON → 起 agentDeckMcpServer，callerSessionIdProvider
 *   走 lazy 工厂（每次 tool 调用时拿当前 SDK session id = applicationSid；tools.ts 内强制覆盖
 *   args.caller_session_id 防 prompt 注入；mcp send_message no-shared-team check 走 sessions.id
 *   维度，需用 applicationSid 才命中 team_member 行）
 */

import { getAgentDeckMcpServerForSession } from '@main/agent-deck-mcp/server';
import type { InternalSession } from './types';
import type { SessionAdapterId } from '@shared/types';
import { buildMcpServersWithHost } from './mcp-server-core';
import { desktopClaudeMcpServerHost } from './mcp-server-host';

type McpServerConfig = Awaited<ReturnType<typeof getAgentDeckMcpServerForSession>>;

/**
 * 起 agentDeckMcpServer（plan task-mcp-merge-into-agent-deck-mcp-20260521 后单 server）。
 *
 * lazy provider 设计：callerSessionIdProvider 是 closure 函数，**每次 tool 调用时**才执行 →
 * 拿到当前最新的 internal.applicationSid（plan reverse-rename-sid-stability-20260520 §A.4-pre S2
 * 双阶段化：spawn 主路径 first realId 到达时切到 realId 后冻结 / resume/fallback 路径
 * caller 入参 opts.resume 全程不变），且能反映会话期间 team membership 变化。
 *
 * **R4 HIGH-H 修订**：5+ 处 provider/getter/map access 维度统一改用 applicationSid (S4b)，
 * 防反向 rename 后 cliSid != appSid 时把 cli sid 当应用 sid 用破不变量 3/4。
 *
 * **mcp send_message no-shared-team check 走 findSharedActiveTeams JOIN team_members.session_id**
 * (= sessions.id 维度，spike3 §3.4)，caller_session_id 必须 applicationSid 才命中 team_member 行。
 * tempKey 阶段沿用宽容策略：caller 反查不到 sessionRepo 时不阻塞，tools.ts validateExternalCaller
 * 仅在 transport='in-process' 时跳过反查。
 */
export async function buildMcpServersForSession(
  internal: InternalSession,
  adapterId: Extract<SessionAdapterId, 'claude-code'>,
): Promise<{
  agentDeckMcpServer: McpServerConfig | null;
}> {
  return buildMcpServersWithHost(
    desktopClaudeMcpServerHost,
    internal,
    adapterId,
  );
}
