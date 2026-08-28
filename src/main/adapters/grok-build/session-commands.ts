import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { SessionCommandDescriptor } from '@shared/types';
import { normalizeSessionCommands } from '@shared/session-commands';

export function commandsFromGrokUpdate(
  update: SessionUpdate,
): SessionCommandDescriptor[] | null {
  if (update.sessionUpdate !== 'available_commands_update') return null;
  return normalizeSessionCommands(update.availableCommands.map((command) => ({
    name: command.name,
    description: command.description,
    argumentHint: command.input?.hint,
  })));
}

export function copyGrokSessionCommands(
  commands: readonly SessionCommandDescriptor[] | undefined,
): SessionCommandDescriptor[] {
  return (commands ?? []).map((command) => ({
    ...command,
    aliases: [...command.aliases],
  }));
}
