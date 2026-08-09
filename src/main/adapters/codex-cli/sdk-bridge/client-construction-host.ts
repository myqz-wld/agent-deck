import { getCodexSkillExtraRootsForSession } from '@main/codex-config/skills-installer';
import { settingsStore } from '@main/store/settings-store';
import { createDesktopCodexAppServerClient } from '../app-server/client-diagnostics';
import type { CodexClientConstructionHost } from './client-construction';

function snapshotProcessEnv(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) snapshot[key] = value;
  }
  return snapshot;
}

export const desktopCodexClientConstructionHost: CodexClientConstructionHost = {
  createClient: createDesktopCodexAppServerClient,
  readCodexCliPath: () => settingsStore.get('codexCliPath'),
  readSettings: () => settingsStore.getAll(),
  readSkillExtraRoots: getCodexSkillExtraRootsForSession,
  snapshotProcessEnv,
};
