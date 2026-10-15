import * as snapshotFilesystem from 'node:fs';
import { publishAssetSnapshot } from '@main/runtime-assets/snapshot-store';
import { sessionAssetSelections } from '@main/runtime-assets/session-selection';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  const selections = sessionAssetSelections(pluginProfilesRoot);

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

  const preparePluginProfile = async (
    profileOptions: GrokPluginProfileOptions,
    sessionId?: string,
  ): Promise<string | null> => {
    const prepare = (): string[] => {
      if (!profileOptions.includeSkills && !profileOptions.includeAgents) return [];
      const snapshot = publishAssetSnapshot({
        source: pluginRoot, destination: pluginProfilesRoot,
        identity: { provider: 'grok', skills: profileOptions.includeSkills, agents: profileOptions.includeAgents },
        omit: [ ...(!profileOptions.includeSkills ? ['skills'] : []), ...(!profileOptions.includeAgents ? ['agents'] : []) ],
        validate: path => { JSON.parse(snapshotFilesystem.readFileSync(join(path, 'plugin.json'), 'utf8')); },
      }, snapshotFilesystem);
      selections.retire([snapshot.path]);
      return [snapshot.path];
    };
    return (sessionId ? selections.select(sessionId, prepare) : prepare())[0] ?? null;
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
