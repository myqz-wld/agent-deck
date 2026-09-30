import { isJsonObject, type JsonObject, type JsonValue } from '@contracts/index';
import { redactJson, truncateUtf8, type FeishuPendingCard } from '@gateways/im';
import { FEISHU_FIELD_LABELS, feishuDisplayValue } from '@gateways/im/display-labels';

const MAX_DETAIL_BYTES = 12_000;
const TOOL_LABELS: Readonly<Record<string, string>> = {
  task_create: '创建待办', task_update: '更新待办', task_delete: '删除待办',
  spawn_session: '创建工作会话', send_message: '发送消息', shutdown_session: '关闭会话',
  create_work_session: '创建工作会话', rename_work_session: '重命名工作会话',
  update_feishu_preferences: '保存聊天与工作会话设置',
};
const MANAGEMENT_TOOLS = new Set(['create_work_session', 'rename_work_session', 'update_feishu_preferences']);
const STATES: Record<FeishuPendingCard['state'], string> = {
  pending: '等待确认', resolved: '已处理', denied: '已拒绝', cancelled: '已取消', expired: '已过期', stale: '已失效',
};

export function safeCardMarkdown(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('<', '‹').replaceAll('>', '›')
    .replaceAll('[', '［').replaceAll(']', '］').replaceAll('`', 'ˋ')
    .replaceAll('*', '\\*').replaceAll('_', '\\_').replaceAll('~', '\\~');
}

function valueText(value: JsonValue): string {
  const safe = redactJson(value, { maxDepth: 10, maxEntries: 1_024, maxStringBytes: 48 * 1_024 });
  return typeof safe === 'string' ? safe : JSON.stringify(safe, null, 2);
}

function fields(value: JsonObject, localized = false): string[] {
  return Object.entries(value).map(([key, value]) =>
    `**${safeCardMarkdown(FEISHU_FIELD_LABELS[key] ?? key)}**\n${localized && isJsonObject(value)
      ? fields(value, true).join('\n') : safeCardMarkdown(typeof value === 'string' && localized
        ? feishuDisplayValue(key, value) : valueText(value))}`);
}

function permissionDetails(details: JsonObject): string {
  const input = isJsonObject(details.input) ? details.input : {};
  const meta = isJsonObject(input._meta) ? input._meta : {};
  if (meta.codex_approval_kind === 'mcp_tool_call' && isJsonObject(meta.tool_params)) {
    const message = typeof input.message === 'string' ? input.message : '';
    const match = message.match(/^Allow the .+ MCP server to run tool "([A-Za-z0-9_.:-]+)"\?$/);
    const tool = typeof meta.tool_name === 'string' ? meta.tool_name : match?.[1];
    const known = input.serverName === 'agent-deck' && tool !== undefined;
    const operation = tool ? (known && TOOL_LABELS[tool]) || `调用工具 · ${tool}` : message || String(details.tool ?? '工具调用');
    const parameters = known && MANAGEMENT_TOOLS.has(tool!)
      ? Object.fromEntries(Object.entries(meta.tool_params).filter(([key]) => !['requestId', 'expectedSettingsRevision'].includes(key)))
      : meta.tool_params;
    return [`**${safeCardMarkdown(operation)}**`, ...fields(parameters, known)].join('\n\n');
  }
  // Unknown tools retain every input field; presentation never guesses away an authorization parameter.
  return [`**${safeCardMarkdown(String(details.tool ?? '工具调用'))}**`, ...fields(input)].join('\n\n');
}

export function pendingCardContent(card: FeishuPendingCard): { content: string; canApprove: boolean } {
  const permission = card.display.requestKind === 'permission';
  const details = isJsonObject(card.display.details) ? card.display.details : null;
  const title = safeCardMarkdown(card.title);
  let body = typeof card.display.notice === 'string' ? safeCardMarkdown(card.display.notice)
    : permission && details ? permissionDetails(details)
      : details ? fields(details).join('\n\n')
        : fields(Object.fromEntries(Object.entries(card.display).filter(([key]) =>
          !['sessionId', 'requestId', 'requestKind', 'questionIds'].includes(key)))).join('\n\n');
  const truncated = new TextEncoder().encode(body).byteLength > MAX_DETAIL_BYTES;
  if (truncated) body = truncateUtf8(body, MAX_DETAIL_BYTES);
  const canApprove = !permission || (details?.complete === true && !truncated);
  const notice = permission && !canApprove ? '\n\n详情未完整显示，请在 Agent Deck 中查看并确认。'
    : permission && card.state === 'pending' ? '\n\n确认后继续这项操作。' : '';
  return { content: `**${title}** · ${STATES[card.state]}\n\n${body}${notice}`, canApprove };
}
