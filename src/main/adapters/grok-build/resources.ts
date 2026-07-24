import { app } from 'electron';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import log from '@main/utils/logger';

const preparedPluginProfiles = new Map<string, Promise<string>>();
const USER_GROK_AGENTS_FILENAME = 'agent-deck-grok-agents.md';
const logger = log.scope('grok-build-resources');

export function getGrokConfigRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'grok-config')
    : join(app.getAppPath(), 'resources', 'grok-config');
}

export function getGrokPluginRoot(): string {
  return join(getGrokConfigRoot(), 'agent-deck-plugin');
}

function getUserGrokAgentsPath(): string {
  return join(app.getPath('userData'), USER_GROK_AGENTS_FILENAME);
}

export async function loadGrokBaselinePrompt(): Promise<string | null> {
  try {
    const { content } = await getActiveGrokAgentsMd();
    return content.trim() || null;
  } catch {
    return null;
  }
}

export async function getBuiltinGrokAgentsMd(): Promise<string> {
  return readFile(join(getGrokConfigRoot(), 'GROK_AGENTS.md'), 'utf8');
}

/** Read the app-owned custom convention when present, otherwise the packaged Grok baseline. */
export async function getActiveGrokAgentsMd(): Promise<{
  content: string;
  isCustom: boolean;
}> {
  try {
    return {
      content: await readFile(getUserGrokAgentsPath(), 'utf8'),
      isCustom: true,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && code !== 'ENOENT') {
      logger.warn('[grok-resources] failed to read custom application convention', error);
    }
    return { content: await getBuiltinGrokAgentsMd(), isCustom: false };
  }
}

/** Atomically save the app-owned Grok application convention; user ~/.grok files stay untouched. */
export async function saveUserGrokAgentsMd(
  content: string,
): Promise<{ content: string; isCustom: true }> {
  const path = getUserGrokAgentsPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
  return { content: await readFile(path, 'utf8'), isCustom: true };
}

/** Remove the app-owned custom copy so future Grok sessions use the packaged baseline again. */
export async function resetUserGrokAgentsMd(): Promise<void> {
  await rm(getUserGrokAgentsPath(), { force: true });
}

/**
 * Grok accepts whole plugin directories. Build a small app-owned mirror so the Skills and Agents
 * toggles remain independent without touching ~/.grok or mutating bundled resources.
 */
export function prepareGrokPluginProfile(options: {
  includeSkills: boolean;
  includeAgents: boolean;
}): Promise<string | null> {
  if (!options.includeSkills && !options.includeAgents) return Promise.resolve(null);
  const key = `${options.includeSkills ? 'skills' : ''}${
    options.includeAgents ? '-agents' : ''
  }`;
  const existing = preparedPluginProfiles.get(key);
  if (existing) return existing;
  const pending = materializePluginProfile(key, options);
  preparedPluginProfiles.set(key, pending);
  pending.catch(() => preparedPluginProfiles.delete(key));
  return pending;
}

async function materializePluginProfile(
  key: string,
  options: { includeSkills: boolean; includeAgents: boolean },
): Promise<string> {
  const source = getGrokPluginRoot();
  const target = join(app.getPath('userData'), 'grok-plugin-profiles', key);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(join(source, 'plugin.json'), join(target, 'plugin.json'));
  if (options.includeSkills) {
    await cp(join(source, 'skills'), join(target, 'skills'), { recursive: true });
  }
  if (options.includeAgents) {
    await cp(join(source, 'agents'), join(target, 'agents'), { recursive: true });
  }
  return target;
}
