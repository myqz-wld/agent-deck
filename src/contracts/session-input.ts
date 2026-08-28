import { isJsonObject } from './json';
import type { SessionConsoleAttachmentPolicyDescriptor } from './session-console-capabilities';
import {
  parseSessionConsoleAttachmentPolicyDescriptor,
} from './session-console-capabilities';
import type { SessionCommandDescriptor } from '@shared/types';

export type SessionActiveTurnInputMode = 'interject' | 'queue' | 'steer';

export interface SessionInputCapabilitiesParams {
  sessionId: string;
}

export interface SessionInputCapabilitiesResult {
  adapterId: 'claude-code' | 'codex-cli' | 'grok-build';
  activeTurn: {
    mode: SessionActiveTurnInputMode;
    attachments: SessionConsoleAttachmentPolicyDescriptor;
  };
  commands: SessionCommandDescriptor[];
  revision: number;
}

export class SessionInputContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionInputContractError';
  }
}

export function parseSessionInputCapabilitiesResult(
  value: unknown,
): SessionInputCapabilitiesResult {
  if (!isJsonObject(value)) throw new SessionInputContractError('session input result is invalid');
  const keys = Object.keys(value);
  if (
    keys.length !== 4 ||
    keys.some((key) => !['activeTurn', 'adapterId', 'commands', 'revision'].includes(key)) ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    typeof value.adapterId !== 'string' ||
    !['claude-code', 'codex-cli', 'grok-build'].includes(value.adapterId) ||
    !isJsonObject(value.activeTurn) ||
    !Array.isArray(value.commands)
  ) throw new SessionInputContractError('session input result fields are invalid');
  const turnKeys = Object.keys(value.activeTurn);
  if (
    turnKeys.length !== 2 ||
    turnKeys.some((key) => !['attachments', 'mode'].includes(key)) ||
    typeof value.activeTurn.mode !== 'string' ||
    !['interject', 'queue', 'steer'].includes(value.activeTurn.mode)
  ) throw new SessionInputContractError('active turn input fields are invalid');
  let attachments: SessionConsoleAttachmentPolicyDescriptor;
  try {
    attachments = parseSessionConsoleAttachmentPolicyDescriptor(value.activeTurn.attachments);
  } catch (error) {
    throw new SessionInputContractError(
      error instanceof Error ? error.message : 'active turn attachment policy is invalid',
    );
  }
  return {
    adapterId: value.adapterId as SessionInputCapabilitiesResult['adapterId'],
    activeTurn: {
      mode: value.activeTurn.mode as SessionActiveTurnInputMode,
      attachments,
    },
    commands: parseCommands(value.commands),
    revision: Number(value.revision),
  };
}

function parseCommands(value: unknown[]): SessionCommandDescriptor[] {
  if (value.length > 256) throw new SessionInputContractError('session command list is too large');
  return value.map((entry) => {
    if (!isJsonObject(entry)) throw new SessionInputContractError('session command is invalid');
    const keys = Object.keys(entry);
    if (
      keys.length !== 4 ||
      keys.some((key) => !['aliases', 'argumentHint', 'description', 'name'].includes(key)) ||
      typeof entry.name !== 'string' ||
      entry.name.length === 0 ||
      entry.name.length > 128 ||
      typeof entry.description !== 'string' ||
      entry.description.length > 512 ||
      typeof entry.argumentHint !== 'string' ||
      entry.argumentHint.length > 256 ||
      !Array.isArray(entry.aliases) ||
      entry.aliases.length > 16 ||
      entry.aliases.some((alias) => typeof alias !== 'string' || alias.length > 128)
    ) throw new SessionInputContractError('session command fields are invalid');
    return {
      name: entry.name,
      description: entry.description,
      argumentHint: entry.argumentHint,
      aliases: [...entry.aliases] as string[],
    };
  });
}
