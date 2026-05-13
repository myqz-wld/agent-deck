/**
 * Wire prefix parser — 与 main 端 `universal-message-watcher.buildWireBody` 形式对称。
 *
 * `buildWireBody` 在 cross-session teammate message 顶部注入：
 *   `[from <displayName> @ <adapterId>][msg <messageId>]\n<body>`
 *
 * Renderer 端（plan mcp-bug-and-feature-batch-20260513 §决策 5 方案 B）parse 出来用于：
 *   1. 隐藏 prefix 只显示 body，保持 chat bubble 干净
 *   2. header 加 chip 显示「来自 X」让用户一眼看出是 cross-session message
 *
 * 注意：J bug 修法（§决策 1 方案 1）让 reply 不再 inject 给 sender SDK，所以 lead detail
 * 不再有 reply 'message' kind event。chip 主要在 teammate detail 起作用（teammate 收 lead
 * send_message）+ 任何 cross-session send。
 */

export interface WirePrefixParse {
  /** displayName（来自 team_member.display_name 或 `<adapterId>:<sid 前 8>` fallback）*/
  from: string;
  /** adapterId（claude-code / codex-cli / aider / generic-pty）*/
  adapter: string;
  /** messageId — B7 阶段后 buildWireBody 必带；老历史事件可能没有 */
  msgId?: string;
  /** 去掉 prefix 的真正消息 body */
  body: string;
}

const WIRE_PREFIX_RE = /^\[from ([^\]]+) @ ([^\]]+)\](?:\[msg ([^\]]+)\])?\n/;

/**
 * 从 message text 解析 wire prefix。
 * 返回 null 表示该 text 不是 cross-session message（普通 user input）。
 *
 * regex 安全性：displayName / adapterId / msgId 都用 `[^\]]+` 防贪婪匹配越界 `]`。
 * 实际 buildWireBody 不会写入 `]` 字符，但防御性匹配避免 displayName 异常字符引发误 parse。
 */
export function parseWirePrefix(text: string): WirePrefixParse | null {
  if (typeof text !== 'string' || !text.startsWith('[from ')) return null;
  const m = WIRE_PREFIX_RE.exec(text);
  if (!m) return null;
  const [matched, from, adapter, msgId] = m;
  return {
    from,
    adapter,
    ...(msgId ? { msgId } : {}),
    body: text.slice(matched.length),
  };
}
