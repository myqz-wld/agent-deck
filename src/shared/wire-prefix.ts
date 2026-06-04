/**
 * **shared/** category: **policy**（跨进程业务规则 — wire prefix parse 逻辑）。
 *
 * Wire prefix parser — 与 main 端 `universal-message-watcher.buildWireBody` 形式对称。
 *
 * `buildWireBody` 在 cross-session teammate message 顶部注入：
 *   `[from <displayName> @ <adapterId>][msg <messageId>][sid <senderSessionId>]\n<body>`
 *
 * Renderer 端（plan mcp-bug-and-feature-batch-20260513 §决策 5 方案 B）parse 出来用于：
 *   1. 隐藏 prefix 只显示 body，保持 chat bubble 干净
 *   2. header 加 chip 显示「来自 X」让用户一眼看出是 cross-session message
 *
 * CHANGELOG_100 / plan mcp-tool-simplify-20260514 D9：wire format 升级，新增 `[sid <senderSessionId>]`
 * 段（双锚点 messageId + senderSessionId），让 teammate 从 wire prefix 直接拿到 lead session_id
 * 调 send_message 回 lead（不必依赖 spawn 时一次性注入的 lead context block）。老历史事件
 * 兼容：sid 段标记为可选，老 wire（无 sid 段）仍能 parse 成功。
 *
 * 协议变更原委（删 reply_message + wait_reply + check_reply 三个 tool 后）：
 * teammate reply lead 必须用 send_message({session_id: <lead-sid>, team_id, text, reply_to_message_id})，
 * 三个必填字段都要从某处拿。spawn 时一次性注入 lead context block 是 anchor，wire prefix 双锚点
 * 是每条 message 的 anchor — 双层冗余对抗协议漂移。
 */

export interface WirePrefixParse {
  /** displayName（来自 team_member.display_name 或 `<adapterId>:<sid 前 8>` fallback）*/
  from: string;
  /** adapterId（claude-code / deepseek-claude-code / codex-cli）*/
  adapter: string;
  /** messageId — B7 阶段后 buildWireBody 必带；老历史事件可能没有 */
  msgId?: string;
  /** senderSessionId — CHANGELOG_100 后 buildWireBody 必带；老历史事件无此字段 */
  senderSessionId?: string;
  /** 去掉 prefix 的真正消息 body */
  body: string;
}

const WIRE_PREFIX_RE =
  /^\[from ([^\]]+) @ ([^\]]+)\](?:\[msg ([^\]]+)\])?(?:\[sid ([^\]]+)\])?\n/;

/**
 * Sanitize wire prefix field value — replace chars that would break parser regex
 * (`]` ends segment / `\n` ends prefix / `[` confuses humans reading raw text)
 * with single space. Leading / trailing whitespace also collapsed so wire prefix
 * stays predictable.
 *
 * CHANGELOG_100 R2 fix (codex MED-1): caller-controlled fields like session.title
 * (used as displayName), agentId, and similar can contain `]` (e.g. `feat: [test]`)
 * — without sanitization, `[from foo]bar @ ...]` would be parsed wrong by
 * `parseWirePrefix` regex (greedy `[^\]]+` capture stops at first `]`), making
 * the chip not render and hand-off context not fold. Apply at every wire prefix
 * write site (spawn handler / buildWireBody / future adapters).
 *
 * Returns single-space fallback when input becomes empty after sanitize (rare:
 * displayName=`]]]` or `\n\n`).
 */
export function sanitizeWireFieldName(raw: string): string {
  if (typeof raw !== 'string') return ' ';
  const cleaned = raw.replace(/[\][\n\r]+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : ' ';
}

/**
 * 从 message text 解析 wire prefix。
 * 返回 null 表示该 text 不是 cross-session message（普通 user input）。
 *
 * regex 安全性：displayName / adapterId / msgId / senderSessionId 都用 `[^\]]+` 防贪婪匹配越界 `]`。
 * 实际 buildWireBody 不会写入 `]` 字符，但防御性匹配避免 displayName 异常字符引发误 parse。
 */
export function parseWirePrefix(text: string): WirePrefixParse | null {
  if (typeof text !== 'string' || !text.startsWith('[from ')) return null;
  const m = WIRE_PREFIX_RE.exec(text);
  if (!m) return null;
  const [matched, from, adapter, msgId, senderSessionId] = m;
  return {
    from,
    adapter,
    ...(msgId ? { msgId } : {}),
    ...(senderSessionId ? { senderSessionId } : {}),
    body: text.slice(matched.length),
  };
}
