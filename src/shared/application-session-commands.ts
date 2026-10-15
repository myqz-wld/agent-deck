import type { SessionCommandDescriptor } from './types';
import { mergeSessionCommands } from './session-commands';
import type { SessionComponentAction } from './session-component-refresh';

export const DECK_REFRESH_USAGE = '用法：/deck-refresh 刷新当前会话扩展；/deck-refresh cancel 撤销排队中的扩展刷新。请单独发送命令，不附带文件或其他文字。';
export function parseDeckRefreshCommand(text: string, hasAttachments = false): SessionComponentAction | 'invalid' | null {
  const trimmed = text.trim();
  if (!/^\/deck-refresh(?:\s|$)/i.test(trimmed)) return null;
  if (hasAttachments || /[\r\n]/.test(trimmed)) return 'invalid';
  if (/^\/deck-refresh$/i.test(trimmed)) return 'refresh';
  if (/^\/deck-refresh\s+cancel$/i.test(trimmed)) return 'cancel';
  return 'invalid';
}

export function withApplicationSessionCommands(commands: readonly SessionCommandDescriptor[]): SessionCommandDescriptor[] {
  return mergeSessionCommands([{
    name: 'deck-refresh', description: 'Agent Deck 应用命令：在空闲边界刷新当前会话扩展；cancel 撤销排队中的扩展刷新。',
    argumentHint: '[cancel]', aliases: [],
  }], commands.map(command => ({ ...command,
    aliases: command.aliases.filter(alias => alias.toLowerCase() !== 'deck-refresh'),
  })));
}
