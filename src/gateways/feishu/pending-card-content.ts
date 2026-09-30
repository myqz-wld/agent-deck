import { isJsonObject, type JsonObject, type JsonValue } from '@contracts/index';
import { redactJson, truncateUtf8, type FeishuPendingCard } from '@gateways/im';

const MAX_DETAIL_BYTES = 12_000;
const FIELD_LABELS: Readonly<Record<string, string>> = {
  subject: '标题', description: '内容', command: '命令', cwd: '工作目录', workingDirectory: '工作目录',
  path: '路径', file_path: '文件', sessionId: '目标会话', adapter: '助手', model: '模型', thinking: '思考程度',
};
const TOOL_LABELS: Readonly<Record<string, string>> = {
  task_create: '创建待办', task_update: '更新待办', task_delete: '删除待办',
  spawn_session: '创建工作会话', send_message: '发送消息', shutdown_session: '关闭会话',
};
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

function fields(value: JsonObject): string[] {
  return Object.entries(value).map(([key, value]) =>
    `**${safeCardMarkdown(FIELD_LABELS[key] ?? key)}**\n${safeCardMarkdown(valueText(value))}`);
}

function permissionDetails(details: JsonObject): string {
  const input = isJsonObject(details.input) ? details.input : {};
  const meta = isJsonObject(input._meta) ? input._meta : {};
  if (meta.codex_approval_kind === 'mcp_tool_call' && isJsonObject(meta.tool_params)) {
    const message = typeof input.message === 'string' ? input.message : '';
    const match = message.match(/^Allow the .+ MCP server to run tool "([A-Za-z0-9_.:-]+)"\?$/);
    const tool = typeof meta.tool_name === 'string' ? meta.tool_name : match?.[1];
    const operation = tool ? `${TOOL_LABELS[tool] ?? '调用工具'} · ${tool}` : message || String(details.tool ?? '工具调用');
    return [`**${safeCardMarkdown(operation)}**`, ...fields(meta.tool_params)].join('\n\n');
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
