import { app } from 'electron';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const preparedPluginProfiles = new Map<string, Promise<string>>();

export function getGrokConfigRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'grok-config')
    : join(app.getAppPath(), 'resources', 'grok-config');
}

export function getGrokPluginRoot(): string {
  return join(getGrokConfigRoot(), 'agent-deck-plugin');
}

export async function loadGrokBaselinePrompt(): Promise<string | null> {
  try {
    return (await readFile(join(getGrokConfigRoot(), 'GROK_AGENTS.md'), 'utf8')).trim();
  } catch {
    return null;
  }
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
