import {
  isJsonObject,
  parseWorkspaceDirectoryRef,
  type JsonObject,
} from '@contracts/index';
import { parsePreferenceCommand, parseCreateOverrides, type PreferenceCommand } from './preference-commands';
import type { FeishuModelPreference, FeishuPreferencePurpose } from '@contracts/index';
import { FeishuGatewayError } from './errors';
import type { FeishuInboundEvent } from './types';
import { requireBoundedText, stableToken } from './validation';

export type FeishuCommand = (
  | PreferenceCommand
  | { kind: 'new'; initialMessage?: string }
  | { kind: 'new-conversation' }
  | { kind: 'create'; adapterId: string | null; initialMessage: string; workingDirectory: string; selection?: Partial<FeishuModelPreference>; purpose?: FeishuPreferencePurpose }
  | { kind: 'directories'; cursor?: string }
  | { kind: 'help' }
  | { kind: 'history'; cursor?: string }
  | { kind: 'pending' }
  | { kind: 'runtime-get' }
  | { kind: 'runtime-update'; expectedRevision: number; patch: JsonObject }
  | { kind: 'select'; sessionId: string }
  | { kind: 'session-delete-confirm'; token: string }
  | { kind: 'session-delete-prepare' }
  | { kind: 'send'; text: string }
  | { kind: 'sessions'; cursor?: string }
  | { kind: 'subscribe'; subscribed: boolean }
) & { target?: 'assistant' };

function exactArgument(
  input: string,
  expression: RegExp,
  usage: string,
): RegExpMatchArray {
  const match = input.match(expression);
  if (!match) throw new FeishuGatewayError('invalid_command', `用法：${usage}`);
  return match;
}

function parseRevision(value: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new FeishuGatewayError('invalid_command', 'revision 必须是非负整数');
  }
  return revision;
}

export function parseFeishuCommand(text: string, maximumTextBytes = 16_384): FeishuCommand {
  const bounded = requireBoundedText(text, maximumTextBytes);
  const input = bounded.trim();
  if (input.length === 0) {
    throw new FeishuGatewayError('invalid_command', '消息不能为空');
  }
  if (!input.startsWith('/')) return { kind: 'send', text: bounded };
  const preferenceCommand = parsePreferenceCommand(input);
  if (preferenceCommand) return preferenceCommand;
  if (input === '/new') return { kind: 'new' };
  if (input.startsWith('/new ')) return { kind: 'new', initialMessage: input.slice(5).trim() };
  if (input === '/chat new') return { kind: 'new-conversation' };
  if (input === '/chat list' || input.startsWith('/chat list ')) return {
    ...parseFeishuCommand('/sessions' + input.slice('/chat list'.length), maximumTextBytes), target: 'assistant',
  };
  const chatControl = input.match(/^\/chat (history|pending|runtime|subscribe|unsubscribe|select)(?: (.*))?$/);
  if (chatControl) return { ...parseFeishuCommand('/' + chatControl[1] +
    (chatControl[2] ? ' ' + chatControl[2] : ''), maximumTextBytes), target: 'assistant' };
  if (input === '/help') return { kind: 'help' };
  if (input === '/sessions') return { kind: 'sessions' };
  if (input.startsWith('/sessions ')) {
    const [, cursor] = exactArgument(input, /^\/sessions ([^\s]+)$/, '/sessions [cursor]');
    return { kind: 'sessions', cursor: stableToken(cursor, 'cursor', 512) };
  }
  if (input === '/directories') return { kind: 'directories' };
  if (input.startsWith('/directories ')) {
    const [, cursor] = exactArgument(
      input,
      /^\/directories ([^\s]+)$/,
      '/directories [cursor]',
    );
    return { kind: 'directories', cursor: stableToken(cursor, 'cursor', 512) };
  }
  if (input.startsWith('/select')) {
    const [, sessionId] = exactArgument(input, /^\/select ([^\s]+)$/, '/select <session-id>');
    return { kind: 'select', sessionId: stableToken(sessionId, 'sessionId') };
  }
  if (input.startsWith('/create')) {
    const [, adapterId, rawWorkingDirectory, rawInitialMessage] = exactArgument(
      input,
      /^\/create ([^\s]+) ([\s\S]+?) -- ([\s\S]+)$/,
      '/create <adapter-id> <workspace-relative-directory> -- <first-message>',
    );
    if (!['last', 'default', 'claude-code', 'codex-cli', 'grok-build'].includes(adapterId)) {
      throw new FeishuGatewayError('invalid_command', '使用 /models 查看可用助手，或用 last 沿用上次选择');
    }
    const overrides = parseCreateOverrides(rawWorkingDirectory);
    let workingDirectory: string;
    try {
      workingDirectory = parseWorkspaceDirectoryRef(
        overrides.directory,
        'workingDirectory',
      );
    } catch {
      throw new FeishuGatewayError(
        'invalid_command',
        '工作目录必须位于 Workspace 内，并使用相对路径',
      );
    }
    return {
      kind: 'create',
      adapterId: ['last', 'default'].includes(adapterId) ? null : stableToken(adapterId, 'adapterId'),
      ...(Object.keys(overrides.selection).length ? { selection: overrides.selection } : {}),
      initialMessage: requireBoundedText(rawInitialMessage, maximumTextBytes),
      workingDirectory,
    };
  }
  if (input === '/history') return { kind: 'history' };
  if (input.startsWith('/history ')) {
    const [, cursor] = exactArgument(input, /^\/history ([^\s]+)$/, '/history [cursor]');
    return { kind: 'history', cursor: stableToken(cursor, 'cursor', 512) };
  }
  if (input === '/pending') return { kind: 'pending' };
  if (input === '/delete') return { kind: 'session-delete-prepare' };
  if (input.startsWith('/delete-confirm')) {
    const [, confirmationToken] = exactArgument(
      input,
      /^\/delete-confirm ([A-Za-z0-9_-]{32})$/,
      '/delete-confirm <confirmation-token>',
    );
    return { kind: 'session-delete-confirm', token: confirmationToken };
  }
  if (input === '/runtime') return { kind: 'runtime-get' };
  if (input.startsWith('/runtime-set')) {
    const [, rawRevision, rawPatch] = exactArgument(
      input,
      /^\/runtime-set ([0-9]+) (\{.*\})$/s,
      '/runtime-set <revision> <JSON-patch>',
    );
    let patch: unknown;
    try {
      patch = JSON.parse(rawPatch);
    } catch {
      throw new FeishuGatewayError('invalid_command', 'runtime patch 必须是有效 JSON');
    }
    if (!isJsonObject(patch)) {
      throw new FeishuGatewayError('invalid_command', 'runtime patch 必须是 JSON object');
    }
    return { kind: 'runtime-update', expectedRevision: parseRevision(rawRevision), patch };
  }
  if (input === '/subscribe') return { kind: 'subscribe', subscribed: true };
  if (input === '/unsubscribe') return { kind: 'subscribe', subscribed: false };
  if (input.startsWith('/send')) {
    const [, message] = exactArgument(input, /^\/send ([\s\S]+)$/, '/send <text>');
    return { kind: 'send', text: requireBoundedText(message, maximumTextBytes) };
  }
  throw new FeishuGatewayError('unknown_command', '未知命令；发送 /help 查看可用命令');
}

export const FEISHU_HELP_TEXT = [
  '直接发送消息即可聊天或安排任务。首次使用先发送 /settings 选择助手。',
  '/settings — 查看或修改机器人聊天、新建会话的上次选择',
  '/models [adapter-id] [provider] — 查看可用助手与模型选项',
  '普通文字 → 机器人助手，独立保留聊天上下文',
  '/new [需求] — 沿用工作会话配置新建会话',
  '/chat new — 重开助手聊天，保留旧聊天记录',
  '/chat history 或 /chat pending — 查看助手历史或待确认事项',
  '/chat list 或 /chat select <ID> — 查看、切回以前的助手聊天',
  '/sessions [cursor] — 分页列出 session',
  '/directories [cursor] — 查看 Workspace 内的工作目录建议',
  '/select <session-id> — 选择工作会话，不切换助手聊天',
  '/create last <目录> -- <需求> — 沿用上次的新建会话配置',
  '/create <adapter-id> <目录> [--model <模型>] [--provider <网关>] [--thinking <程度>] -- <需求> — 覆盖并记住选择',
  '/history [cursor] — 查看所选工作会话历史',
  '/send <内容> — 发送给所选工作会话',
  '/runtime — 查看 adapter runtime controls',
  '/runtime-set <revision> <JSON-patch> — 更新 runtime controls',
  '/pending — 查看仍在 pending 的请求',
  '/delete — 预览并生成当前 session 的删除确认',
  '/delete-confirm <confirmation-token> — 确认删除当前 session',
  '/subscribe 或 /unsubscribe — 管理当前 session 通知',
].join('\n');

export function classifyFeishuOperation(event: FeishuInboundEvent): string {
  if (event.kind === 'card-action') return event.action.name;
  try {
    return parseFeishuCommand(event.text).kind;
  } catch {
    return 'unknown-command';
  }
}
