import { join } from 'node:path';
import { getApplicationHostPaths } from '@main/runtime-host/application-paths';
import { sessionAssetSelections } from './session-selection';

/** Startup-only GC: deleting history never races a provider still draining its last tool. */
export function initializeDesktopAssetSelections(): void {
  const root = getApplicationHostPaths().userDataPath;
  for (const name of ['agent-deck-plugin', 'codex-agent-deck-skills', 'grok-plugin-profiles']) {
    try { sessionAssetSelections(join(root, name)).collectReleased(); }
    catch { /* Preserve unknown ownership and retry during a later startup. */ }
  }
}
