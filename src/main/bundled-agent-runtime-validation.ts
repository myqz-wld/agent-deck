import {
  ASSET_LIMITS,
  ASSET_NAME_REGEX,
  type AssetAdapter,
  type BundledAgentRuntimeOverride,
  type BundledAgentRuntimeOverrideMap,
} from '@shared/types';
import {
  isClaudeThinkingLevel,
  isCodexThinkingLevel,
  isGrokThinkingLevel,
} from '@shared/session-metadata';

const ADAPTERS: readonly AssetAdapter[] = ['claude-code', 'codex-cli', 'grok-build'];
const MAX_OVERRIDE_COUNT = 128;
const ALLOWED_FIELDS = new Set(['model', 'thinking', 'provider']);

export function bundledAgentRuntimeKey(adapter: AssetAdapter, name: string): string {
  return `${adapter}:${name}`;
}

export function normalizeBundledAgentRuntimeOverride(
  adapter: AssetAdapter,
  value: unknown,
): BundledAgentRuntimeOverride {
  if (!isPlainObject(value)) throw new Error('override must be a plain object');
  for (const key of Object.keys(value)) {
    if (!ALLOWED_FIELDS.has(key)) throw new Error(`unknown override field "${key}"`);
  }

  const model = normalizeOptionalField('model', value.model, ASSET_LIMITS.runtimeModel);
  const thinking = normalizeOptionalField('thinking', value.thinking, 16);
  const provider = normalizeOptionalField('provider', value.provider, ASSET_LIMITS.provider);
  if (thinking && !isThinkingValidForAdapter(adapter, thinking)) {
    throw new Error(`thinking "${thinking}" is not valid for ${adapter}`);
  }
  if (provider && adapter === 'grok-build') {
    throw new Error('provider is supported only for claude-code or codex-cli bundled Agents');
  }
  return {
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(provider ? { provider } : {}),
  };
}

export function normalizeBundledAgentRuntimeOverrideMap(
  value: unknown,
): BundledAgentRuntimeOverrideMap {
  if (!isPlainObject(value)) throw new Error('must be a plain object');
  const entries = Object.entries(value);
  if (entries.length > MAX_OVERRIDE_COUNT) {
    throw new Error(`contains more than ${MAX_OVERRIDE_COUNT} bundled Agent overrides`);
  }
  const normalized: BundledAgentRuntimeOverrideMap = {};
  for (const [key, rawOverride] of entries) {
    const splitAt = key.indexOf(':');
    const adapter = key.slice(0, splitAt) as AssetAdapter;
    const name = key.slice(splitAt + 1);
    if (
      splitAt <= 0 ||
      !ADAPTERS.includes(adapter) ||
      !ASSET_NAME_REGEX.test(name) ||
      name.length > ASSET_LIMITS.name
    ) {
      throw new Error(`invalid bundled Agent override key "${key}"`);
    }
    const override = normalizeBundledAgentRuntimeOverride(adapter, rawOverride);
    if (Object.keys(override).length > 0) normalized[key] = override;
  }
  return normalized;
}

function normalizeOptionalField(
  name: string,
  value: unknown,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength) {
    throw new Error(`${name} length must not exceed ${maxLength}`);
  }
  if (/[\r\n\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${name} must be a single printable line`);
  }
  return normalized;
}

function isThinkingValidForAdapter(adapter: AssetAdapter, value: string): boolean {
  if (adapter === 'codex-cli') return isCodexThinkingLevel(value);
  if (adapter === 'grok-build') return isGrokThinkingLevel(value);
  return isClaudeThinkingLevel(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
