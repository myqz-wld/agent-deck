import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CodexConfigProfileOption } from '@shared/types';
import { CODEX_CONFIG_PROFILE_ID_PATTERN } from '@shared/codex-config-profile';
import { getCodexHome } from './plugin-assets';

export { CODEX_CONFIG_PROFILE_ID_PATTERN } from '@shared/codex-config-profile';

export interface CodexConfigProfilePaths {
  codexHome: string;
}

export interface ResolvedCodexConfigProfile {
  id: string;
  configPath: string;
}

export function defaultCodexConfigProfilePaths(): CodexConfigProfilePaths {
  return { codexHome: getCodexHome() };
}

export function assertCodexConfigProfileId(profileId: string): void {
  if (!CODEX_CONFIG_PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error(
      `Invalid Codex config profile "${profileId}". Use 1-128 letters, digits, dot, underscore, or hyphen; the first character must be alphanumeric.`,
    );
  }
}

export function codexConfigProfilePath(
  profileId: string,
  paths: CodexConfigProfilePaths = defaultCodexConfigProfilePaths(),
): string {
  assertCodexConfigProfileId(profileId);
  return join(paths.codexHome, `${profileId}.config.toml`);
}

/** Discover native `$CODEX_HOME/<name>.config.toml` profile files without parsing or rewriting them. */
export function listCodexConfigProfiles(
  paths: CodexConfigProfilePaths = defaultCodexConfigProfilePaths(),
): CodexConfigProfileOption[] {
  let entries;
  try {
    entries = readdirSync(paths.codexHome, { withFileTypes: true });
  } catch {
    return [];
  }

  const profiles: CodexConfigProfileOption[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.config.toml')) continue;
    const id = basename(entry.name, '.config.toml');
    if (!CODEX_CONFIG_PROFILE_ID_PATTERN.test(id)) continue;
    const configPath = join(paths.codexHome, entry.name);
    try {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!statSync(configPath).isFile()) continue;
    } catch {
      continue;
    }
    profiles.push({ id, configPath });
  }
  return profiles.sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveCodexConfigProfile(
  profile: string | null | undefined,
  paths: CodexConfigProfilePaths = defaultCodexConfigProfilePaths(),
): ResolvedCodexConfigProfile | null {
  const id = profile?.trim();
  if (!id) return null;
  const configPath = codexConfigProfilePath(id, paths);
  if (!existsSync(configPath)) {
    throw new Error(
      `Codex config profile "${id}" was not found at ${configPath}. Create that profile file, choose another profile, or clear the profile to use config.toml.`,
    );
  }
  try {
    if (!statSync(configPath).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(
      `Codex config profile "${id}" is not a readable file at ${configPath}. Choose another profile or clear the profile to use config.toml.`,
    );
  }
  return { id, configPath };
}
