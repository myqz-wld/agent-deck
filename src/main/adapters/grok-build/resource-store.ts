import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const USER_GROK_AGENTS_FILENAME = 'agent-deck-grok-agents.md';

export interface GrokResourceDiagnostics {
  warn(message: string, error: unknown): void;
}

export interface GrokPluginProfileOptions {
  includeSkills: boolean;
  includeAgents: boolean;
}

export interface GrokResourceStoreOptions {
  configRoot: string;
  userDataPath: string;
  diagnostics?: GrokResourceDiagnostics;
}

export interface GrokAgentsDocument {
  content: string;
  isCustom: boolean;
}

export function createGrokResourceStore(options: GrokResourceStoreOptions) {
  const pluginRoot = join(options.configRoot, 'agent-deck-plugin');
  const userAgentsPath = join(options.userDataPath, USER_GROK_AGENTS_FILENAME);
  const pluginProfilesRoot = join(options.userDataPath, 'grok-plugin-profiles');
  const preparedPluginProfiles = new Map<string, Promise<string>>();

  const getBuiltinAgents = (): Promise<string> =>
    readFile(join(options.configRoot, 'GROK_AGENTS.md'), 'utf8');

  const getActiveAgents = async (): Promise<GrokAgentsDocument> => {
    try {
      return { content: await readFile(userAgentsPath, 'utf8'), isCustom: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && code !== 'ENOENT') {
        options.diagnostics?.warn(
          '[grok-resources] failed to read custom application convention',
          error,
        );
      }
      return { content: await getBuiltinAgents(), isCustom: false };
    }
  };

  const loadBaselinePrompt = async (): Promise<string | null> => {
    try {
      const { content } = await getActiveAgents();
      return content.trim() || null;
    } catch {
      return null;
    }
  };

  const saveUserAgents = async (content: string): Promise<GrokAgentsDocument> => {
    await mkdir(dirname(userAgentsPath), { recursive: true });
    const temporaryPath = `${userAgentsPath}.tmp.${process.pid}`;
    await writeFile(temporaryPath, content, 'utf8');
    await rename(temporaryPath, userAgentsPath);
    return { content: await readFile(userAgentsPath, 'utf8'), isCustom: true };
  };

  const resetUserAgents = (): Promise<void> => rm(userAgentsPath, { force: true });

  const materializePluginProfile = async (
    key: string,
    profileOptions: GrokPluginProfileOptions,
  ): Promise<string> => {
    const target = join(pluginProfilesRoot, key);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await cp(join(pluginRoot, 'plugin.json'), join(target, 'plugin.json'));
    if (profileOptions.includeSkills) {
      await cp(join(pluginRoot, 'skills'), join(target, 'skills'), { recursive: true });
    }
    if (profileOptions.includeAgents) {
      await cp(join(pluginRoot, 'agents'), join(target, 'agents'), { recursive: true });
    }
    return target;
  };

  const preparePluginProfile = (
    profileOptions: GrokPluginProfileOptions,
  ): Promise<string | null> => {
    if (!profileOptions.includeSkills && !profileOptions.includeAgents) {
      return Promise.resolve(null);
    }
    const key = `${profileOptions.includeSkills ? 'skills' : ''}${
      profileOptions.includeAgents ? '-agents' : ''
    }`;
    const existing = preparedPluginProfiles.get(key);
    if (existing) return existing;
    const pending = materializePluginProfile(key, profileOptions);
    preparedPluginProfiles.set(key, pending);
    pending.catch(() => preparedPluginProfiles.delete(key));
    return pending;
  };

  return Object.freeze({
    configRoot: options.configRoot,
    pluginRoot,
    getBuiltinAgents,
    getActiveAgents,
    loadBaselinePrompt,
    saveUserAgents,
    resetUserAgents,
    preparePluginProfile,
  });
}

export type GrokResourceStore = ReturnType<typeof createGrokResourceStore>;
