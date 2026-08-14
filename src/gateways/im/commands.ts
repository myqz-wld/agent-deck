import {
  isJsonObject,
  parseWorkspaceDirectoryRef,
  type JsonObject,
} from '@contracts/index';
import { FeishuGatewayError } from './errors';
import type { FeishuInboundEvent } from './types';
import { requireBoundedText, stableToken } from './validation';

export type FeishuCommand =
  | { kind: 'create'; adapterId: string; initialMessage: string; workingDirectory: string }
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
  | { kind: 'subscribe'; subscribed: boolean };

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
    let workingDirectory: string;
    try {
      workingDirectory = parseWorkspaceDirectoryRef(
        rawWorkingDirectory,
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
      adapterId: stableToken(adapterId, 'adapterId'),
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
  '/sessions [cursor] — 分页列出 session',
  '/directories [cursor] — 查看 Workspace 内的工作目录建议',
  '/select <session-id> — 选择 session',
  '/create <adapter-id> <workspace-relative-directory> -- <first-message> — 在 Workspace 内创建 session',
  '/history [cursor] — 查看历史',
  '/send <text> — 发送消息（普通文本也会发送）',
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
