import { isJsonObject } from './json';

const ADAPTERS = new Set(['claude-code', 'codex-cli', 'grok-build']);
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MAX_COMPONENT_BYTES = 4_096;

export interface SessionContextRuntimeIdentityDto {
  version: 1;
  runtimeKey: string;
  adapter: 'claude-code' | 'codex-cli' | 'grok-build';
  runtimeProvider: string;
  model: string;
  capacityConfigFingerprint: string;
}

export interface SessionContextUsageDto {
  usedTokens: number | null;
  windowTokens: number | null;
  updatedAt: number;
  runtimeIdentity: SessionContextRuntimeIdentityDto | null;
}

export interface SessionContextGetParams {
  sessionId: string;
}

export interface SessionContextGetResult {
  contextUsage: SessionContextUsageDto | null;
  revision: number;
}

export class SessionContextContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionContextContractError';
  }
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new SessionContextContractError(`${label} keys are invalid`);
  }
}

function component(value: unknown, label: string): string {
  if (
    typeof value !== 'string' || value.length === 0 ||
    Buffer.byteLength(value) > MAX_COMPONENT_BYTES || CONTROL.test(value)
  ) throw new SessionContextContractError(`${label} is invalid`);
  return value;
}

function nonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new SessionContextContractError(`${label} is invalid`);
  }
  return Number(value);
}

function positive(value: unknown, label: string): number {
  const parsed = nonNegative(value, label);
  if (parsed === 0) throw new SessionContextContractError(`${label} is invalid`);
  return parsed;
}

function identity(value: unknown): SessionContextRuntimeIdentityDto {
  if (!isJsonObject(value)) {
    throw new SessionContextContractError('context runtime identity is invalid');
  }
  exactKeys(value, [
    'adapter',
    'capacityConfigFingerprint',
    'model',
    'runtimeKey',
    'runtimeProvider',
    'version',
  ], 'context runtime identity');
  if (value.version !== 1 || typeof value.adapter !== 'string' || !ADAPTERS.has(value.adapter)) {
    throw new SessionContextContractError('context runtime identity version or adapter is invalid');
  }
  return {
    version: 1,
    adapter: value.adapter as SessionContextRuntimeIdentityDto['adapter'],
    runtimeKey: component(value.runtimeKey, 'context runtime key'),
    runtimeProvider: component(value.runtimeProvider, 'context runtime provider'),
    model: component(value.model, 'context runtime model'),
    capacityConfigFingerprint: component(
      value.capacityConfigFingerprint,
      'context capacity fingerprint',
    ),
  };
}

export function parseSessionContextGetResult(value: unknown): SessionContextGetResult {
  if (!isJsonObject(value)) throw new SessionContextContractError('context result is invalid');
  exactKeys(value, ['contextUsage', 'revision'], 'context result');
  const revision = nonNegative(value.revision, 'context revision');
  if (value.contextUsage === null) return { contextUsage: null, revision };
  if (!isJsonObject(value.contextUsage)) {
    throw new SessionContextContractError('context usage is invalid');
  }
  exactKeys(value.contextUsage, [
    'runtimeIdentity', 'updatedAt', 'usedTokens', 'windowTokens',
  ], 'context usage');
  const usedTokens = value.contextUsage.usedTokens === null
    ? null
    : nonNegative(value.contextUsage.usedTokens, 'context usedTokens');
  const windowTokens = value.contextUsage.windowTokens === null
    ? null
    : positive(value.contextUsage.windowTokens, 'context windowTokens');
  return {
    revision,
    contextUsage: {
      usedTokens,
      windowTokens,
      updatedAt: nonNegative(value.contextUsage.updatedAt, 'context updatedAt'),
      runtimeIdentity: value.contextUsage.runtimeIdentity === null
        ? null
        : identity(value.contextUsage.runtimeIdentity),
    },
  };
}
