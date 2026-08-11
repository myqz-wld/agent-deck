import { isJsonObject } from './json';
import type { SessionConsoleAttachmentPolicyDescriptor } from './session-console-capabilities';
import {
  parseSessionConsoleAttachmentPolicyDescriptor,
} from './session-console-capabilities';

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
    keys.length !== 3 ||
    keys.some((key) => !['activeTurn', 'adapterId', 'revision'].includes(key)) ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    typeof value.adapterId !== 'string' ||
    !['claude-code', 'codex-cli', 'grok-build'].includes(value.adapterId) ||
    !isJsonObject(value.activeTurn)
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
    revision: Number(value.revision),
  };
}
