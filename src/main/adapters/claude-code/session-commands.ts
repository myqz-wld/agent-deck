import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { SessionCommandDescriptor } from '@shared/types';
import {
  mergeSessionCommands,
  normalizeSessionCommands,
} from '@shared/session-commands';

const CLAUDE_HOST_COMMANDS = normalizeSessionCommands([
  {
    name: 'clear',
    description: '清空 Claude 上下文并在当前 Agent Deck session 中开始新对话',
  },
  {
    name: 'compact',
    description: '压缩当前 Claude 对话上下文',
  },
]);

/** Keep explicit SDK lifecycle commands available when command discovery is temporarily down. */
export async function listClaudeSessionCommands(
  query: Pick<Query, 'supportedCommands'> | null,
): Promise<SessionCommandDescriptor[]> {
  if (!query) return CLAUDE_HOST_COMMANDS.map(copyCommand);
  try {
    const commands = normalizeSessionCommands(await query.supportedCommands());
    return mergeSessionCommands(commands, CLAUDE_HOST_COMMANDS);
  } catch {
    return CLAUDE_HOST_COMMANDS.map(copyCommand);
  }
}

function copyCommand(command: SessionCommandDescriptor): SessionCommandDescriptor {
  return { ...command, aliases: [...command.aliases] };
}
