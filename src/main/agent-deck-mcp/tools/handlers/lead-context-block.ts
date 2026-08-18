/**
 * Build the current spawn-session wire prefix and lead context block from one shared template.
 * The target uses the persisted message id as its first reply anchor and sends the result back to
 * the still-active lead through send_message.
 */

import { sanitizeWireFieldName } from '@shared/wire-prefix';
import { HAND_OFF_SPAWN_HEADER } from '@shared/hand-off-headers';

export interface BuildLeadContextBlockOpts {
  /** caller(lead)session id,放入 wire prefix `[sid <id>]` + lead context block "Lead sessionId" 字段 */
  leadSessionId: string;
  /**
   * caller/new session shared team id(teamIdEarly) when a team was created or reused.
   * `null` means standalone spawn; send_message should omit teamId and use teamless DM.
   * Not included in the wire prefix; rendered only in the lead context block.
   */
  teamId: string | null;
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
   * Lead sessionId / Team id or teamless mode / Lead displayName 字段 + send_message 用法 codeblock +
   * replyToMessageId 和 sender sessionId 提取说明)。**不**含 wire prefix 自己 —
   * wirePrefix 字段独立 prepend。
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
  const teamLine =
    opts.teamId === null
      ? `- Team id: (none; omit \`teamId\` so send_message uses teamless DM)\n`
      : `- Team id: \`${opts.teamId}\`\n`;
  const teamArgLine =
    opts.teamId === null
      ? ``
      : `  teamId: '${opts.teamId}',  // current team id\n`;

  const contextBlock =
    `${HAND_OFF_SPAWN_HEADER}\n` +
    `- Lead sessionId: \`${opts.leadSessionId}\`\n` +
    teamLine +
    `- Lead displayName: ${opts.leadDisplayName ?? '(unset)'}\n` +
    `\n` +
    `Reply to the lead with Agent Deck MCP after you finish this turn:\n` +
    `\`\`\`\n` +
    `mcp__agent-deck__send_message({\n` +
    `  sessionId: '${opts.leadSessionId}',  // lead sessionId\n` +
    teamArgLine +
    `  text: '<reply text>',\n` +
    `  replyToMessageId: '<msg-id from wire prefix>'\n` +
    `})\n` +
    `\`\`\`\n` +
    `Extract \`replyToMessageId\` from the top wire prefix \`[msg <id>]\`. Reply to the actual sender in \`[sid <senderSid>]\`; for later or rescue messages, replace the example \`sessionId\` above with that sender sid.\n`;

  const wirePrefix = `[from ${leadFromName} @ ${leadAdapterSanitized}][msg ${opts.placeholderId}][sid ${opts.leadSessionId}]\n`;

  return { wirePrefix, contextBlock };
}
