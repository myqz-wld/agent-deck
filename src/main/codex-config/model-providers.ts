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

/**
 * Side-effect-free suggestions for the bundled Codex Agent editor.
 * The returned ids still refer to provider definitions owned by native Codex config.
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
