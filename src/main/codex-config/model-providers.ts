import { existsSync, readFileSync } from 'node:fs';
import type { CodexModelProviderOption } from '@shared/types';
import {
  getCodexConfigPath,
  readTopLevelModelProviderFromCodexConfig,
} from './toml-writer';

const PROVIDER_HEADER =
  /^\s*\[model_providers\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))]\s*(?:#.*)?$/;
const NAME_ASSIGNMENT =
  /^\s*name\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/;
const MAX_PROVIDER_ID_LENGTH = 256;

/**
 * Side-effect-free suggestions for native Codex model providers. The returned ids refer to
 * definitions owned exclusively by the user's `$CODEX_HOME/config.toml`.
 */
export function listCodexModelProviders(
  configPath: string = getCodexConfigPath(),
): CodexModelProviderOption[] {
  const configuredDefault = readTopLevelModelProviderFromCodexConfig(configPath);
  if (!existsSync(configPath)) {
    return configuredDefault ? [toOption(configuredDefault, undefined, configuredDefault)] : [];
  }

  let content: string;
  try {
    content = readFileSync(configPath, 'utf8');
  } catch {
    return configuredDefault ? [toOption(configuredDefault, undefined, configuredDefault)] : [];
  }

  const providers = new Map<string, { id: string; name?: string }>();
  let currentId: string | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const header = PROVIDER_HEADER.exec(rawLine);
    if (header) {
      currentId = decodeTomlKey(header[1] ?? header[2] ?? header[3] ?? '');
      if (currentId) providers.set(currentId, { id: currentId });
      continue;
    }
    if (/^\s*\[/.test(rawLine)) {
      currentId = null;
      continue;
    }
    if (!currentId) continue;
    const name = NAME_ASSIGNMENT.exec(rawLine);
    if (!name) continue;
    const decoded = decodeTomlString(name[1]);
    if (decoded) providers.set(currentId, { id: currentId, name: decoded });
  }

  if (configuredDefault && !providers.has(configuredDefault)) {
    providers.set(configuredDefault, { id: configuredDefault });
  }
  return [...providers.values()]
    .map((provider) => toOption(provider.id, provider.name, configuredDefault))
    .sort((a, b) => {
      if (a.configuredAsTopLevelDefault !== b.configuredAsTopLevelDefault) {
        return a.configuredAsTopLevelDefault ? -1 : 1;
      }
      return a.id.localeCompare(b.id);
    });
}

/** Validate a selected provider without mutating native Codex configuration. */
export function resolveCodexModelProvider(
  provider: string | null | undefined,
  configPath: string = getCodexConfigPath(),
): CodexModelProviderOption | null {
  const id = provider?.trim();
  if (!id) return null;
  if (id.length > MAX_PROVIDER_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new Error('Codex model_provider 无效：不能包含控制字符或超过 256 个字符。');
  }
  const resolved = listCodexModelProviders(configPath).find((option) => option.id === id);
  if (!resolved) {
    throw new Error(
      `Codex model_provider "${id}" 不存在于 ${configPath} 的 [model_providers.*] 配置中。`,
    );
  }
  return resolved;
}

function toOption(
  id: string,
  name: string | undefined,
  configuredDefault: string | null,
): CodexModelProviderOption {
  return {
    id,
    ...(name ? { name } : {}),
    configuredAsTopLevelDefault: id === configuredDefault,
  };
}

function decodeTomlKey(value: string): string {
  return value.includes('\\') ? decodeTomlString(`"${value}"`) : value;
}

function decodeTomlString(token: string): string {
  if (token.startsWith("'")) return token.slice(1, -1);
  try {
    return JSON.parse(token) as string;
  } catch {
    return token.slice(1, -1);
  }
}
