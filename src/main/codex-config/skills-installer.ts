/**
 * Agent Deck bundled Codex skills runtime loader.
 *
 * Agent Deck no longer installs bundled skills into user-level
 * `~/.codex/skills/agent-deck`. In-app Codex app-server sessions receive a
 * substituted mirror under app userData through `skills/extraRoots/set`.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { settingsStore } from '@main/store/settings-store';
import { substituteResourcesPlaceholder } from '@main/utils/resources-placeholder';
import log from '@main/utils/logger';
import { getApplicationResourcesRoot } from '@main/runtime-host/application-resources';
import { getApplicationHostPaths } from '@main/runtime-host/application-paths';
import {
  createSkillsMirrorStore,
  type SkillsMirrorDiagnostic,
  type SkillsMirrorFilesystem,
  type SkillsMirrorStore,
} from './skills-mirror-store';

const logger = log.scope('codex-skills-installer');

export type { SkillsMirrorFilesystem } from './skills-mirror-store';

const defaultSkillsMirrorFilesystem: SkillsMirrorFilesystem = {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
};

let skillsMirrorFilesystem = defaultSkillsMirrorFilesystem;
let skillsMirrorStore = createMirrorStore(skillsMirrorFilesystem);
let preparedSkillNames: string[] | null = null;

/** Test-only reset/injection point. */
export function __setSkillsMirrorFilesystemForTests(
  overrides: Partial<SkillsMirrorFilesystem> = {},
): void {
  skillsMirrorFilesystem = { ...defaultSkillsMirrorFilesystem, ...overrides };
  skillsMirrorStore = createMirrorStore(skillsMirrorFilesystem);
  preparedSkillNames = null;
}

function createMirrorStore(filesystem: SkillsMirrorFilesystem): SkillsMirrorStore {
  return createSkillsMirrorStore({
    filesystem,
    transformMarkdown: substituteResourcesPlaceholder,
    diagnostic: logSkillsMirrorDiagnostic,
  });
}

function logSkillsMirrorDiagnostic(event: SkillsMirrorDiagnostic): void {
  switch (event.kind) {
    case 'source-missing':
      logger.warn(`[codex-skills] builtin skills source missing: ${event.source}`);
      return;
    case 'source-inspection-failed':
      logger.warn(
        `[codex-skills] inspect builtin skills source failed: ${event.source}`,
        event.error,
      );
      return;
    case 'prepare-failed':
      logger.warn(
        `[codex-skills] prepare skill extra root failed: ${event.destination}`,
        event.error,
      );
      return;
    case 'rollback-failed':
      logger.warn(
        `[codex-skills] skill mirror rollback failed: ${event.destination}`,
        event.error,
      );
      return;
    case 'cleanup-failed':
      logger.warn(
        `[codex-skills] skill mirror ${event.operation} cleanup failed: ${event.path}`,
        event.error,
      );
  }
}

/** App-owned substituted skills extra root passed to Codex app-server. */
export function getCodexSkillsExtraRootDir(): string {
  return join(getApplicationHostPaths().userDataPath, 'codex-agent-deck-skills');
}

/** Built-in codex plugin skills source directory (dev/prod aware). */
export function getBuiltinCodexSkillsSourceDir(): string {
  return join(
    getApplicationResourcesRoot(),
    'codex-config',
    'agent-deck-plugin',
    'skills',
  );
}

/** Return the root already prepared by bootstrap or the settings apply hook. */
export function getCodexSkillExtraRootsForSession(): string[] {
  if (!settingsStore.get('injectAgentDeckCodexSkills') || !preparedSkillNames?.length) return [];
  const root = getCodexSkillsExtraRootDir();
  return skillsMirrorFilesystem.existsSync(root) ? [root] : [];
}

/**
 * Prepare the app-owned mirror used by bootstrap and settings apply hooks.
 *
 * - When enabled, validates or atomically replaces the bundled skills mirror and returns names.
 * - When disabled, removes the app-owned mirror and returns [].
 * - When the source is missing or preparation fails, returns null and never exposes a stale tree.
 */
export function syncSkills(): string[] | null {
  const mirrorDir = getCodexSkillsExtraRootDir();
  if (!settingsStore.get('injectAgentDeckCodexSkills')) {
    skillsMirrorStore.remove(mirrorDir);
    preparedSkillNames = [];
    return [];
  }
  try {
    const result = skillsMirrorStore.sync({
      source: getBuiltinCodexSkillsSourceDir(),
      destination: mirrorDir,
    });
    preparedSkillNames = result ? [...result] : null;
    return result;
  } catch (error) {
    preparedSkillNames = null;
    throw error;
  }
}
