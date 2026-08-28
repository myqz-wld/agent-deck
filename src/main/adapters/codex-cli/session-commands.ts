import type { SessionCommandDescriptor } from '@shared/types';
import {
  exactSessionCommand,
  normalizeSessionCommands,
} from '@shared/session-commands';

export type CodexHostSessionCommand = 'clear' | 'compact';

const CODEX_SESSION_COMMANDS = normalizeSessionCommands([
  {
    name: 'clear',
    description: '清空 Codex 上下文并在当前 Agent Deck session 中开始新对话',
  },
  {
    name: 'compact',
    description: '压缩当前 Codex 对话上下文',
  },
]);

export function listCodexSessionCommands(): SessionCommandDescriptor[] {
  return CODEX_SESSION_COMMANDS.map((command) => ({
    ...command,
    aliases: [...command.aliases],
  }));
}

export function parseCodexHostSessionCommand(text: string): CodexHostSessionCommand | null {
  const command = exactSessionCommand(CODEX_SESSION_COMMANDS, text);
  return command?.name === 'clear' || command?.name === 'compact' ? command.name : null;
}
