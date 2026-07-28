import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const appPath = app.getAppPath();
const userDataPath = app.getPath('userData');
const sourceRoot = join(appPath, 'resources', 'claude-config', 'agent-deck-plugin');
const mirrorRoot = join(userDataPath, 'agent-deck-plugin');

function writePluginSource(): void {
  mkdirSync(join(sourceRoot, '.claude-plugin'), { recursive: true });
  mkdirSync(join(sourceRoot, 'skills', 'simple-review'), { recursive: true });
  mkdirSync(join(sourceRoot, 'agents'), { recursive: true });
  writeFileSync(
    join(sourceRoot, '.claude-plugin', 'plugin.json'),
    '{"name":"agent-deck","version":"0.0.0-test"}',
    'utf8',
  );
  writeFileSync(join(sourceRoot, 'skills', 'simple-review', 'SKILL.md'), '# simple-review', 'utf8');
  writeFileSync(join(sourceRoot, 'agents', 'reviewer-claude.md'), '# reviewer-claude', 'utf8');
}

async function loadModules(): Promise<{
  settingsStore: typeof import('@main/store/settings-store').settingsStore;
  getClaudeAgentDeckPluginPath: typeof import('./sdk-injection').getClaudeAgentDeckPluginPath;
  getAgentDeckPluginsForSession: typeof import('./sdk-injection').getAgentDeckPluginsForSession;
  setPluginMirrorFilesystemForTests: typeof import('./sdk-injection').__setPluginMirrorFilesystemForTests;
}> {
  const [
    { settingsStore },
    {
      __setPluginMirrorFilesystemForTests: setPluginMirrorFilesystemForTests,
      getAgentDeckPluginsForSession,
      getClaudeAgentDeckPluginPath,
    },
  ] = await Promise.all([
    import('@main/store/settings-store'),
    import('./sdk-injection'),
  ]);
  return {
    settingsStore,
    getClaudeAgentDeckPluginPath,
    getAgentDeckPluginsForSession,
    setPluginMirrorFilesystemForTests,
  };
}

function getMirrorOperationArtifacts(): string[] {
  if (!existsSync(userDataPath)) return [];
  return readdirSync(userDataPath).filter((entry) =>
    /^\.agent-deck-plugin\.(?:staging|backup)-/.test(entry),
  );
}

describe('getAgentDeckPluginsForSession', () => {
  beforeEach(() => {
    vi.resetModules();
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(mirrorRoot, { recursive: true, force: true });
    writePluginSource();
  });

  it('keeps skills and removes agents when only Claude skills injection is enabled', async () => {
    const { settingsStore, getAgentDeckPluginsForSession } = await loadModules();
    settingsStore.set('injectAgentDeckClaudeSkills', true);
    settingsStore.set('injectAgentDeckClaudeAgents', false);

    const plugins = getAgentDeckPluginsForSession();

    expect(plugins).toEqual([{ type: 'local', path: mirrorRoot }]);
    expect(existsSync(join(mirrorRoot, 'skills', 'simple-review', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(mirrorRoot, 'agents'))).toBe(false);
  });

  it('keeps agents and removes skills when only Claude agents injection is enabled', async () => {
    const { settingsStore, getAgentDeckPluginsForSession } = await loadModules();
    settingsStore.set('injectAgentDeckClaudeSkills', false);
    settingsStore.set('injectAgentDeckClaudeAgents', true);

    const plugins = getAgentDeckPluginsForSession();

    expect(plugins).toEqual([{ type: 'local', path: mirrorRoot }]);
    expect(existsSync(join(mirrorRoot, 'agents', 'reviewer-claude.md'))).toBe(true);
    expect(existsSync(join(mirrorRoot, 'skills'))).toBe(false);
  });

  it('omits the plugin entirely when both Claude bundled asset toggles are disabled', async () => {
    const { settingsStore, getAgentDeckPluginsForSession } = await loadModules();
    settingsStore.set('injectAgentDeckClaudeSkills', false);
    settingsStore.set('injectAgentDeckClaudeAgents', false);

    expect(getAgentDeckPluginsForSession()).toEqual([]);
    expect(existsSync(mirrorRoot)).toBe(false);
  });

  it('loads an explicitly selected native Plugin even when bundled assets are disabled', async () => {
    const selectedPlugin = join(userDataPath, 'selected-plugin');
    const { settingsStore, getAgentDeckPluginsForSession } = await loadModules();
    settingsStore.set('injectAgentDeckClaudeSkills', false);
    settingsStore.set('injectAgentDeckClaudeAgents', false);

    expect(getAgentDeckPluginsForSession(selectedPlugin)).toEqual([
      { type: 'local', path: selectedPlugin },
    ]);
    expect(existsSync(mirrorRoot)).toBe(false);
  });

  it('returns null and omits the bundled plugin when its source is missing', async () => {
    const { settingsStore, getAgentDeckPluginsForSession, getClaudeAgentDeckPluginPath } = await loadModules();
    settingsStore.set('injectAgentDeckClaudeSkills', true);
    settingsStore.set('injectAgentDeckClaudeAgents', true);
    rmSync(sourceRoot, { recursive: true, force: true });

    expect(getClaudeAgentDeckPluginPath()).toBeNull();
    expect(getAgentDeckPluginsForSession()).toEqual([]);
    expect(existsSync(mirrorRoot)).toBe(false);
  });

  it('omits the mirror and removes its staging directory when copy fails', async () => {
    const { settingsStore, getAgentDeckPluginsForSession, setPluginMirrorFilesystemForTests } = await loadModules();
    settingsStore.set('injectAgentDeckClaudeSkills', true);
    settingsStore.set('injectAgentDeckClaudeAgents', true);
    setPluginMirrorFilesystemForTests({
      cpSync: () => {
        throw new Error('copy failed');
      },
    });

    expect(getAgentDeckPluginsForSession()).toEqual([]);
    expect(existsSync(mirrorRoot)).toBe(false);
    expect(getMirrorOperationArtifacts()).toEqual([]);
  });

  it('does not publish or cache a mirror when pruning the staged tree fails', async () => {
    const { settingsStore, getAgentDeckPluginsForSession, setPluginMirrorFilesystemForTests } = await loadModules();
    settingsStore.set('injectAgentDeckClaudeSkills', false);
    settingsStore.set('injectAgentDeckClaudeAgents', true);
    setPluginMirrorFilesystemForTests({
      rmSync: ((path, options) => {
        if (String(path).endsWith('/skills')) {
          throw new Error('prune failed');
        }
        return rmSync(path, options);
      }) as typeof rmSync,
    });

    expect(getAgentDeckPluginsForSession()).toEqual([]);
    expect(existsSync(mirrorRoot)).toBe(false);
    expect(getMirrorOperationArtifacts()).toEqual([]);
  });

  it('does not publish or cache a mirror when staged markdown substitution fails', async () => {
    const { settingsStore, getAgentDeckPluginsForSession, setPluginMirrorFilesystemForTests } = await loadModules();
    settingsStore.set('injectAgentDeckClaudeSkills', true);
    settingsStore.set('injectAgentDeckClaudeAgents', true);
    setPluginMirrorFilesystemForTests({
      readFileSync: ((path: string | Buffer | URL) => {
        if (String(path).endsWith('SKILL.md')) {
          throw new Error('substitution read failed');
        }
        return readFileSync(path, 'utf8');
      }) as typeof readFileSync,
    });

    expect(getAgentDeckPluginsForSession()).toEqual([]);
    expect(existsSync(mirrorRoot)).toBe(false);
    expect(getMirrorOperationArtifacts()).toEqual([]);
  });

  it('keeps the previous live mirror but omits it from a session when publish fails', async () => {
    const {
      settingsStore,
      getAgentDeckPluginsForSession,
      setPluginMirrorFilesystemForTests,
    } = await loadModules();
    const sourceSkill = join(sourceRoot, 'skills', 'simple-review', 'SKILL.md');
    const mirrorSkill = join(mirrorRoot, 'skills', 'simple-review', 'SKILL.md');
    writeFileSync(sourceSkill, '# old reader', 'utf8');
    settingsStore.set('injectAgentDeckClaudeSkills', true);
    settingsStore.set('injectAgentDeckClaudeAgents', true);
    expect(getAgentDeckPluginsForSession()).toEqual([{ type: 'local', path: mirrorRoot }]);

    writeFileSync(sourceSkill, '# replacement', 'utf8');
    setPluginMirrorFilesystemForTests({
      renameSync: ((from, to) => {
        if (String(from).includes('.agent-deck-plugin.staging-') && String(to) === mirrorRoot) {
          throw new Error('publish failed');
        }
        return renameSync(from, to);
      }) as typeof renameSync,
    });

    expect(getAgentDeckPluginsForSession()).toEqual([]);
    expect(readFileSync(mirrorSkill, 'utf8')).toBe('# old reader');
    expect(getMirrorOperationArtifacts()).toEqual([]);
  });

  it('keeps readers on the old complete mirror until a complete staged replacement publishes', async () => {
    const {
      settingsStore,
      getAgentDeckPluginsForSession,
      setPluginMirrorFilesystemForTests,
    } = await loadModules();
    const sourceSkill = join(sourceRoot, 'skills', 'simple-review', 'SKILL.md');
    const mirrorSkill = join(mirrorRoot, 'skills', 'simple-review', 'SKILL.md');
    writeFileSync(sourceSkill, '# old reader', 'utf8');
    settingsStore.set('injectAgentDeckClaudeSkills', true);
    settingsStore.set('injectAgentDeckClaudeAgents', true);
    expect(getAgentDeckPluginsForSession()).toEqual([{ type: 'local', path: mirrorRoot }]);

    writeFileSync(sourceSkill, '# replacement', 'utf8');
    let readerSawOldMirrorDuringCopy = false;
    let stagedMirrorWasCompleteAtPublish = false;
    setPluginMirrorFilesystemForTests({
      cpSync: ((source, destination, options) => {
        const result = cpSync(source, destination, options);
        readerSawOldMirrorDuringCopy = readFileSync(mirrorSkill, 'utf8') === '# old reader';
        return result;
      }) as typeof cpSync,
      renameSync: ((from, to) => {
        if (String(from).includes('.agent-deck-plugin.staging-') && String(to) === mirrorRoot) {
          stagedMirrorWasCompleteAtPublish =
            readFileSync(join(String(from), 'skills', 'simple-review', 'SKILL.md'), 'utf8') ===
            '# replacement';
        }
        return renameSync(from, to);
      }) as typeof renameSync,
    });

    expect(getAgentDeckPluginsForSession()).toEqual([{ type: 'local', path: mirrorRoot }]);
    expect(readerSawOldMirrorDuringCopy).toBe(true);
    expect(stagedMirrorWasCompleteAtPublish).toBe(true);
    expect(readFileSync(mirrorSkill, 'utf8')).toBe('# replacement');
    expect(getMirrorOperationArtifacts()).toEqual([]);
  });

  it('caches only a successful publication and retries the next session after failure', async () => {
    const { settingsStore, getAgentDeckPluginsForSession, setPluginMirrorFilesystemForTests } = await loadModules();
    settingsStore.set('injectAgentDeckClaudeSkills', true);
    settingsStore.set('injectAgentDeckClaudeAgents', true);
    let copyAttempts = 0;
    setPluginMirrorFilesystemForTests({
      cpSync: ((source, destination, options) => {
        copyAttempts += 1;
        if (copyAttempts === 1) {
          throw new Error('first copy fails');
        }
        return cpSync(source, destination, options);
      }) as typeof cpSync,
    });

    expect(getAgentDeckPluginsForSession()).toEqual([]);
    expect(getAgentDeckPluginsForSession()).toEqual([{ type: 'local', path: mirrorRoot }]);
    expect(getAgentDeckPluginsForSession()).toEqual([{ type: 'local', path: mirrorRoot }]);
    expect(copyAttempts).toBe(2);
  });
});
