import { isAgentId } from '@main/adapters/options-builder';
import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';
import {
  isAdapterSessionMode,
  type SessionHandOffPrepareRequest,
  type SessionHandOffTarget,
} from '@shared/types';
import {
  IpcInputError,
  parseGrokSandboxProfile,
  parseStringId,
} from './_helpers';

const HAND_OFF_TARGET_KEYS = new Set([
  'adapter',
  'provider',
  'model',
  'thinking',
  'sessionMode',
  'grokSandbox',
]);
const HAND_OFF_PREPARE_KEYS = new Set([
  'sourceSessionId',
  'continuationInstruction',
  'target',
]);

export function parseSessionHandOffTarget(value: unknown): SessionHandOffTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IpcInputError('request.target', 'must be object');
  }
  const raw = value as Record<string, unknown>;
  rejectUnknownKeys('request.target', raw, HAND_OFF_TARGET_KEYS);
  if (typeof raw.adapter !== 'string' || !isAgentId(raw.adapter)) {
    throw new IpcInputError('request.target.adapter', 'unknown adapter');
  }
  if (raw.model !== null && raw.model !== undefined && typeof raw.model !== 'string') {
    throw new IpcInputError('request.target.model', 'must be a string or null');
  }
  if (
    raw.provider !== null &&
    raw.provider !== undefined &&
    typeof raw.provider !== 'string'
  ) {
    throw new IpcInputError('request.target.provider', 'must be a string or null');
  }
  if (raw.thinking !== null && raw.thinking !== undefined && typeof raw.thinking !== 'string') {
    throw new IpcInputError('request.target.thinking', 'must be a string or null');
  }
  if (
    raw.sessionMode !== null &&
    raw.sessionMode !== undefined &&
    !isAdapterSessionMode(raw.sessionMode)
  ) {
    throw new IpcInputError(
      'request.target.sessionMode',
      'must be default, plan, ask, or null',
    );
  }
  const grokSandbox =
    raw.grokSandbox === null
      ? null
      : parseGrokSandboxProfile(raw.grokSandbox);
  // Runtime ownership and same-adapter inheritance both distinguish omission from explicit null.
  return {
    adapter: raw.adapter,
    ...(raw.provider !== undefined
      ? { provider: typeof raw.provider === 'string' ? raw.provider : null }
      : {}),
    ...(raw.model !== undefined
      ? { model: typeof raw.model === 'string' ? raw.model : null }
      : {}),
    ...(raw.thinking !== undefined
      ? { thinking: typeof raw.thinking === 'string' ? raw.thinking : null }
      : {}),
    ...(raw.sessionMode !== undefined
      ? {
          sessionMode: isAdapterSessionMode(raw.sessionMode)
            ? raw.sessionMode
            : null,
        }
      : {}),
    ...(raw.grokSandbox !== undefined ? { grokSandbox } : {}),
  };
}

export function parseSessionHandOffPrepareRequest(
  value: unknown,
): SessionHandOffPrepareRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IpcInputError('request', 'must be object');
  }
  const raw = value as Record<string, unknown>;
  rejectUnknownKeys('request', raw, HAND_OFF_PREPARE_KEYS);
  const sourceSessionId = parseStringId('request.sourceSessionId', raw.sourceSessionId);
  if (typeof raw.continuationInstruction !== 'string') {
    throw new IpcInputError('request.continuationInstruction', 'must be a string');
  }
  if (!raw.continuationInstruction.trim()) {
    throw new IpcInputError('request.continuationInstruction', 'must not be empty');
  }
  if (raw.continuationInstruction.length > MAX_USER_MESSAGE_LENGTH) {
    throw new IpcInputError(
      'request.continuationInstruction',
      `length > ${MAX_USER_MESSAGE_LENGTH}`,
    );
  }
  return {
    sourceSessionId,
    continuationInstruction: raw.continuationInstruction,
    target: parseSessionHandOffTarget(raw.target),
  };
}

function rejectUnknownKeys(
  field: string,
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  const unknown = Object.keys(raw).find((key) => !allowed.has(key));
  if (unknown) throw new IpcInputError(`${field}.${unknown}`, 'unknown field');
}
