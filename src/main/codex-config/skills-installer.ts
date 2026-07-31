/**
 * Agent Deck bundled Codex skills runtime loader.
 *
 * Agent Deck no longer installs bundled skills into user-level
 * `~/.codex/skills/agent-deck`. In-app Codex app-server sessions receive a
 * substituted mirror under app userData through `skills/extraRoots/set`.
 */
import { app } from 'electron';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { settingsStore } from '@main/store/settings-store';
import { substituteResourcesPlaceholder } from '@main/utils/resources-placeholder';
import log from '@main/utils/logger';

const logger = log.scope('codex-skills-installer');

/** App-owned substituted skills extra root passed to Codex app-server. */
export function getCodexSkillsExtraRootDir(): string {
  return join(app.getPath('userData'), 'codex-agent-deck-skills');
}

/** Built-in codex plugin skills source directory (dev/prod aware). */
export function getBuiltinCodexSkillsSourceDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'codex-config', 'agent-deck-plugin', 'skills');
  }
  return join(app.getAppPath(), 'resources', 'codex-config', 'agent-deck-plugin', 'skills');
}

/**
 * Prepare app-owned Codex skill extra roots for a new in-app Codex session.
 *
 * Returns [] when the settings toggle is disabled or the source directory is missing.
 */
export function getCodexSkillExtraRootsForSession(): string[] {
  if (!settingsStore.get('injectAgentDeckCodexSkills')) return [];

  const mirrorDir = getCodexSkillsExtraRootDir();
  if (!existsSync(mirrorDir)) {
    const written = syncSkills();
    if (!written || written.length === 0) return [];
  }
  return [mirrorDir];
}

/**
 * Prepare the app-owned mirror used by bootstrap and settings apply hooks.
 *
 * - When enabled, mirrors bundled skills to app userData and returns skill names.
 * - When disabled, removes the app-owned mirror and returns [].
 */
export function syncSkills(): string[] | null {
  const mirrorDir = getCodexSkillsExtraRootDir();
  if (!settingsStore.get('injectAgentDeckCodexSkills')) {
    removeDirIfExists(mirrorDir);
    return [];
  }

  const sourceDir = getBuiltinCodexSkillsSourceDir();
  if (!existsSync(sourceDir)) {
    logger.warn(`[codex-skills] builtin skills source missing: ${sourceDir}`);
    return null;
  }

  try {
    removeDirIfExists(mirrorDir);
    mkdirSync(mirrorDir, { recursive: true });
    cpSync(sourceDir, mirrorDir, { recursive: true });
    substituteMdFilesInPlace(mirrorDir);
    return listSkillNames(mirrorDir);
  } catch (err) {
    logger.warn(`[codex-skills] prepare skill extra root failed: ${mirrorDir}`, err);
    return null;
  }
}

function removeDirIfExists(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function listSkillNames(root: string): string[] {
  return readdirSync(root)
    .filter((name) => {
      try {
        return statSync(join(root, name)).isDirectory() && existsSync(join(root, name, 'SKILL.md'));
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b));
}

function substituteMdFilesInPlace(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      substituteMdFilesInPlace(path);
      continue;
    }
    if (!entry.isFile() || !path.endsWith('.md')) continue;
    try {
      const raw = readFileSync(path, 'utf8');
      const substituted = substituteResourcesPlaceholder(raw);
      if (substituted !== raw) writeFileSync(path, substituted, 'utf8');
    } catch (err) {
      logger.warn(`[codex-skills] substitute failed: ${path}`, err);
    }
  }
}
