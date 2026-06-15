import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  getAgentDeckPluginsForSession: typeof import('./sdk-injection').getAgentDeckPluginsForSession;
}> {
  const [{ settingsStore }, { getAgentDeckPluginsForSession }] = await Promise.all([
    import('@main/store/settings-store'),
    import('./sdk-injection'),
  ]);
  return { settingsStore, getAgentDeckPluginsForSession };
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
});
