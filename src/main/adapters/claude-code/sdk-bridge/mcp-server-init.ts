/**
 * MCP server 拼装 — Agent Deck MCP only（plan task-mcp-merge-into-agent-deck-mcp-20260521 合并后）。
 *
 * 抽自 ClaudeSdkBridge.createSession 内 mcp 拼装段（原 ~35 行 inline 紧贴 query() 调用）。
 * 收口到一个 pure builder 里，让 createSession 主体只关心拼装结果。
 *
 * 行为（保持原 createSession 拼装逻辑等价）：
 * - settings.enableAgentDeckMcp ON → 起 agentDeckMcpServer，callerSessionIdProvider
 *   走 lazy 工厂（每次 tool 调用时拿当前 SDK session id = applicationSid；tools.ts 内强制覆盖
 *   args.caller_session_id 防 prompt 注入；mcp send_message no-shared-team check 走 sessions.id
 *   维度，需用 applicationSid 才命中 team_member 行）
 *
 * **plan task-mcp-merge-into-agent-deck-mcp-20260521**：原独立 tasksServer 已合并进 agent-deck-mcp
 * namespace（工具名从 mcp__tasks__task_* 切到 mcp__agent-deck__task_*，breaking change）。
 * 删 enableTaskManager 独立 toggle，task tools 跟随 enableAgentDeckMcp 开关；settings-store.ts
 * REMOVED_KEYS + smart migration 守护老用户 enableTaskManager:true 不丢失能力（详 §D2 R1 F11）。
 */

import { settingsStore } from '@main/store/settings-store';
import { getAgentDeckMcpServerForSession } from '@main/agent-deck-mcp/server';
import type { InternalSession } from './types';
import log from '@main/utils/logger';

const logger = log.scope('claude-mcp-init');

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
): Promise<{
  agentDeckMcpServer: McpServerConfig | null;
}> {
  const enableAgentDeckMcp = settingsStore.get('enableAgentDeckMcp') === true;
  const agentDeckMcpServer = enableAgentDeckMcp
    ? await getAgentDeckMcpServerForSession(() => internal.applicationSid)
    : null;
  if (agentDeckMcpServer) {
    logger.info('[agent-deck-mcp] in-process MCP attached for session (19 public tools)');
  }

  return { agentDeckMcpServer };
}
