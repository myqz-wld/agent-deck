/**
 * lead-context-block.ts —— spawn 路径专用的 wire prefix + lead context block 装配 helper
 * (plan hand-off-session-adopt-teammates-20260520 Phase 4 D11 + Round 4 NEW MED-B 修法)。
 *
 * **抽出动机**(plan §决策对抗 Round 4 MED-B + Round 7 codex MED-2):
 * spawn.ts:218-237 inline 装配的 wire prefix + lead context block 文字模板,在 plan
 * Phase 4 引入 hand_off_session adopt_teammates: true 路径前是单一 caller(spawn 自己用)。
 * 抽 helper 后 SSOT 唯一化 + snapshot test 双向防漂移,**仅** spawn 路径用。
 *
 * **adopt 路径不复用本 helper**(Round 6 codex MED-1 + Round 7 codex MED-2 修法):
 * adopt 路径下 caller 已 archive(default baton)+ newSid 成为新 lead → caller 与 newSid
 * 无 shared active team → 新 session 按本 helper 的 wire prefix + "回 lead 用 send_message"
 * 指令必撞 send.ts:52-61 no-shared-team(deep design hole)。adopt 路径走独立
 * `adopted-teams-context-block.ts` helper 装配,**完全不**复用本 helper(Phase 4c)。
 *
 * **设计语义对比**:
 * - **spawn = 派出小弟**:lead 留在 conversation,teammate 起来后 reply 回 lead 用 wire
 *   prefix `[msg <id>]` 锚点 + send_message → lead 收到 reply auto-injected
 * - **adopt = baton 单向交接**:lead 退出(archive),新 session 接管成为新 lead,与 caller
 *   无 reply chain(caller 已 exit)
 *
 * 两套语义独立,helper 不共用。
 */

import { sanitizeWireFieldName } from '@shared/wire-prefix';
import { HAND_OFF_SPAWN_HEADER } from '@shared/hand-off-headers';

export interface BuildLeadContextBlockOpts {
  /** caller(lead)session id,放入 wire prefix `[sid <id>]` + lead context block "Lead session_id" 字段 */
  leadSessionId: string;
  /**
   * caller team id(teamIdEarly) — 放入 wire prefix(隐式,通过 buildWireBody 协议)
   * + lead context block "Team id" 字段。
   */
  teamId: string;
  /**
   * lead displayName 优先取 leadRecord.title;缺失时 caller 端用
   * `<leadAdapter>:<lead-sid 前 8>` fallback 形态(同 buildWireBody resolveFromDisplayName fallback)。
   * 由 caller 显式传入,本 helper 不做反查 — 让 caller 端控制 fallback chain。
   * `null` = 显式 unset(prompt 内显示 `(unset)`)。
   */
  leadDisplayName: string | null;
  /** lead session adapter id ('claude-code' / 'codex-cli' / 'unknown-adapter');放入 wire prefix `[from <name> @ <adapter>]` */
  leadAdapter: string;
  /** placeholder messageId(crypto.randomUUID 生成);放入 wire prefix `[msg <id>]` 双锚点的第一个锚 */
  placeholderId: string;
}

export interface BuildLeadContextBlockResult {
  /** wire prefix `[from <name> @ <adapter>][msg <id>][sid <senderSid>]\n` 三段(末尾换行) */
  wirePrefix: string;
  /**
   * lead context block 文字模板(`## Hand-off context (auto-injected by Agent Deck MCP)` 标题 +
   * Lead session_id / Team id / Lead displayName 字段 + send_message 用法 codeblock + wire prefix
   * regex 双锚点说明)。**不**含 wire prefix 自己 — wirePrefix 字段独立 prepend。
   */
  contextBlock: string;
}

/**
 * spawn 路径装配 wire prefix + lead context block。caller 在 spawn 之前调用,把
 * `wirePrefix + contextBlock + '\n---\n\n' + originalPrompt` 拼成 `promptForSpawn`
 * 喂 SDK first message;同时把 `placeholderId` 用作 messageId 写入 messages 表占位
 * (DB body 列**不**含 wire prefix,与 send_message buildWireBody 协议同款 — 在内存里加
 * wire prefix 不写回 DB,详 §应用 CLAUDE.md)。
 *
 * **`leadDisplayName` fallback chain**(由 caller 控制,helper 不反查):
 * 1. caller 优先取 leadRecord.title(用户 / cwd-basename 默认)
 * 2. 缺失时 caller 用 `<leadAdapter>:<lead-sid 前 8>` 同 buildWireBody resolveFromDisplayName fallback
 * 3. 都无值显式传 `null` 让本 helper 渲染 `(unset)`(明示 unset 状态而非用 fallback 字串伪装)
 *
 * **`leadAdapter` fallback**(由 caller 控制):leadRecord 缺失时 caller 端用 `'unknown-adapter'`
 * 字面值(同 spawn.ts 现有路径)。
 */
export function buildLeadContextBlock(
  opts: BuildLeadContextBlockOpts,
): BuildLeadContextBlockResult {
  // CHANGELOG_100 R2 fix (codex MED-1): sanitizeWireFieldName 处理 `]` / `\n` / `[`,
  // 避免 user 设的 session.title (e.g. "feat: [test]") 破坏 wire prefix 解析。
  // 同款 sanitize 在 buildWireBody (universal-message-watcher.ts) 也做了。
  const leadFromName = sanitizeWireFieldName(
    opts.leadDisplayName ?? `${opts.leadAdapter}:${opts.leadSessionId.slice(0, 8)}`,
  );
  const leadAdapterSanitized = sanitizeWireFieldName(opts.leadAdapter);

  const contextBlock =
    `${HAND_OFF_SPAWN_HEADER}\n` +
    `- Lead session_id: \`${opts.leadSessionId}\`\n` +
    `- Team id: \`${opts.teamId}\`\n` +
    `- Lead displayName: ${opts.leadDisplayName ?? '(unset)'}\n` +
    `\n` +
    `回 lead 用：\n` +
    `\`\`\`\n` +
    `mcp__agent-deck__send_message({\n` +
    `  session_id: '${opts.leadSessionId}',  // lead session_id\n` +
    `  team_id: '${opts.teamId}',  // 当前 team id\n` +
    `  text: '<reply text>',\n` +
    `  reply_to_message_id: '<msg-id from wire prefix>'  // 从顶部 [msg <id>] 提取\n` +
    `})\n` +
    `\`\`\`\n` +
    `wire prefix regex（双锚点）: \`/\\[msg ([0-9a-f-]+)\\]\\[sid ([0-9a-f-]+)\\]/\`\n`;

  const wirePrefix = `[from ${leadFromName} @ ${leadAdapterSanitized}][msg ${opts.placeholderId}][sid ${opts.leadSessionId}]\n`;

  return { wirePrefix, contextBlock };
}
