/**
 * MCP server 拼装 — Task Manager + Agent Deck MCP（CHANGELOG_85 Step 3.2）。
 *
 * 抽自 ClaudeSdkBridge.createSession 内 mcp 拼装段（原 ~35 行 inline 紧贴 query() 调用）。
 * 把两个 server 的 lazy provider 工厂 + console.log 提示统一收口，让 createSession 主体
 * 只关心拼装结果。
 *
 * 行为（保持原 createSession 拼装逻辑等价）：
 * - settings.enableTaskManager ON → 起 tasksServer，sessionId 用 internal.applicationSid
 *   （plan reverse-rename-sid-stability-20260520 §A.4-pre S4b R4 HIGH-H 修订；plan
 *   task-mcp-owner-session-id-rewrite-20260521 v023 删 teamIdProvider，task 不绑 team，
 *   team scope 在 query 层 reverse join sessions 算）
 * - settings.enableAgentDeckMcp ON → 起 agentDeckMcpServer，callerSessionIdProvider
 *   走 lazy 工厂（每次 tool 调用时拿当前 SDK session id = applicationSid;tools.ts 内强制覆盖
 *   args.caller_session_id 防 prompt 注入；mcp send_message no-shared-team check 走 sessions.id
 *   维度,需用 applicationSid 才命中 team_member 行）
 *
 * 两个 mcp server 是独立 toggle，可同开 / 同关 / 单挂。
 */

import { settingsStore } from '@main/store/settings-store';
import { getTasksMcpServerForSession } from '@main/task-manager/server';
import { getAgentDeckMcpServerForSession } from '@main/agent-deck-mcp/server';
import type { InternalSession } from './types';

type McpServerConfig = Awaited<ReturnType<typeof getTasksMcpServerForSession>>;

/**
 * 起 tasksServer + agentDeckMcpServer（两者独立 toggle，可单可双）。
 *
 * lazy provider 设计：tasksServer 的 sessionIdProvider + agentDeck
 * 的 callerSessionIdProvider 都是 closure 函数，**每次 tool 调用时**才执行 → 拿到
 * 当前最新的 internal.applicationSid (plan reverse-rename-sid-stability-20260520 §A.4-pre S2
 * 双阶段化:spawn 主路径 first realId 到达时切到 realId 后冻结 / resume/fallback 路径
 * caller 入参 opts.resume 全程不变),且能反映会话期间 team membership 变化。
 *
 * **R4 HIGH-H 修订**: 5+ 处 provider/getter/map access 维度统一改用 applicationSid (S4b),
 * 防反向 rename 后 cliSid != appSid 时把 cli sid 当应用 sid 用破不变量 3/4。
 *
 * **plan task-mcp-owner-session-id-rewrite-20260521 v023**: tasksServer 删
 * teamIdProvider 参数 — task 不再绑 team_id，team scope 由 tools.ts handler 用
 * agentDeckTeamRepo.findActiveMembershipsBySession + listActiveMembers 在 query
 * 层 reverse join sessions 算出来。owner_session_id = applicationSid 闭包注入。
 */
export async function buildMcpServersForSession(
  internal: InternalSession,
  _tempKey: string,
): Promise<{
  tasksServer: McpServerConfig | null;
  agentDeckMcpServer: McpServerConfig | null;
}> {
  const enableTaskManager = settingsStore.get('enableTaskManager') === true;
  const tasksServer = enableTaskManager
    ? await getTasksMcpServerForSession(
        // plan task-mcp-owner-session-id-rewrite-20260521 v023: sessionIdProvider
        // 改必填（task_create owner / task_list/update/delete 权限校验都强依赖
        // caller sid）。spawn 主路径 ctor 时 applicationSid = tempKey,first realId
        // 到达后切到 realId 冻结(S2 jsdoc)。
        () => internal.applicationSid,
      )
    : null;
  if (tasksServer) {
    console.log('[task-manager] mcpServers attached for session (v023 owner_session_id model)');
  }

  // CHANGELOG_<X> R2 / B'3：Agent Deck MCP server in-process 注入。开关 ON 时给
  // claude 会话挂 in-process MCP，让 claude 能跨 adapter 编排其他 session
  // （spawn / send / list / get / shutdown / archive_plan / hand_off_session — CHANGELOG_100 7-tool set）。
  // callerSessionIdProvider 走 lazy 工厂,每次 tool 调用时拿当前 SDK session id = applicationSid —
  // tools.ts 内部强制覆盖 args.caller_session_id 防 prompt 注入伪造身份。
  // **R4 HIGH-H 修订**: 改用 internal.applicationSid (替代 internal.realSessionId ?? tempKey) —
  // mcp send_message no-shared-team check 走 findSharedActiveTeams JOIN team_members.session_id
  // (= sessions.id 维度,spike3 §3.4),caller_session_id 必须 applicationSid 才命中 team_member 行。
  // tempKey 阶段沿用 task-manager 同款宽容策略：caller 反查不到 sessionRepo 时不阻塞,
  // tools.ts validateExternalCaller 仅在 transport='in-process' 时跳过反查。
  const enableAgentDeckMcp = settingsStore.get('enableAgentDeckMcp') === true;
  const agentDeckMcpServer = enableAgentDeckMcp
    ? await getAgentDeckMcpServerForSession(() => internal.applicationSid)
    : null;
  if (agentDeckMcpServer) {
    console.log('[agent-deck-mcp] in-process MCP attached for session');
  }

  return { tasksServer, agentDeckMcpServer };
}
