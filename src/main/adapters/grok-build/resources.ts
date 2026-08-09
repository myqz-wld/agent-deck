import { join } from 'node:path';
import log from '@main/utils/logger';
import { getApplicationResourcesRoot } from '@main/runtime-host/application-resources';
import { getApplicationHostPaths } from '@main/runtime-host/application-paths';
import {
  createGrokResourceStore,
  type GrokPluginProfileOptions,
  type GrokResourceStore,
} from './resource-store';

const logger = log.scope('grok-build-resources');
let cachedStore:
  | {
      configRoot: string;
      userDataPath: string;
      store: GrokResourceStore;
    }
  | undefined;

function getStore(): GrokResourceStore {
  const configRoot = join(getApplicationResourcesRoot(), 'grok-config');
  const userDataPath = getApplicationHostPaths().userDataPath;
  if (
    cachedStore?.configRoot === configRoot &&
    cachedStore.userDataPath === userDataPath
  ) {
    return cachedStore.store;
  }
  const store = createGrokResourceStore({
    configRoot,
    userDataPath,
    diagnostics: { warn: (message, error) => logger.warn(message, error) },
  });
  cachedStore = { configRoot, userDataPath, store };
  return store;
}

export function getGrokConfigRoot(): string {
  return getStore().configRoot;
}

export function getGrokPluginRoot(): string {
  return getStore().pluginRoot;
}

export async function loadGrokBaselinePrompt(): Promise<string | null> {
  return getStore().loadBaselinePrompt();
}

export async function getBuiltinGrokAgentsMd(): Promise<string> {
  return getStore().getBuiltinAgents();
}

/** Read the app-owned custom convention when present, otherwise the packaged Grok baseline. */
export async function getActiveGrokAgentsMd(): Promise<{
  content: string;
  isCustom: boolean;
}> {
  return getStore().getActiveAgents();
}

/** Atomically save the app-owned Grok application convention; user ~/.grok files stay untouched. */
export async function saveUserGrokAgentsMd(
  content: string,
): Promise<{ content: string; isCustom: true }> {
  const saved = await getStore().saveUserAgents(content);
  return { content: saved.content, isCustom: true };
}

/** Remove the app-owned custom copy so future Grok sessions use the packaged baseline again. */
export async function resetUserGrokAgentsMd(): Promise<void> {
  await getStore().resetUserAgents();
}

/**
 * Grok accepts whole plugin directories. Build a small app-owned mirror so the Skills and Agents
 * toggles remain independent without touching ~/.grok or mutating bundled resources.
 */
export function prepareGrokPluginProfile(
  options: GrokPluginProfileOptions,
): Promise<string | null> {
  return getStore().preparePluginProfile(options);
}
