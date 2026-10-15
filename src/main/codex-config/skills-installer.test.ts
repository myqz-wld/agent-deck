import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const applicationPaths = vi.hoisted(() => ({
  isPackaged: false,
  appPath: '',
  resourcesPath: '',
  userDataPath: '',
}));

vi.mock('@main/runtime-host/application-paths', () => ({
  getApplicationHostPaths: () => applicationPaths,
}));

const appPath = app.getAppPath();
const userDataPath = app.getPath('userData');
applicationPaths.appPath = appPath;
applicationPaths.resourcesPath = process.resourcesPath;
applicationPaths.userDataPath = userDataPath;
const sourceRoot = join(
  appPath,
  'resources',
  'codex-config',
  'agent-deck-plugin',
  'skills',
);
const mirrorRoot = join(userDataPath, 'codex-agent-deck-skills');
const resourcesPlaceholder = '{{AGENT_DECK_RESOURCES}}';

function writeSkillsSource(marker = 'v1'): void {
  mkdirSync(join(sourceRoot, 'alpha'), { recursive: true });
  mkdirSync(join(sourceRoot, 'beta'), { recursive: true });
  mkdirSync(join(sourceRoot, 'docs-only'), { recursive: true });
  writeFileSync(
    join(sourceRoot, 'alpha', 'SKILL.md'),
    `# alpha ${marker}\n${resourcesPlaceholder}/bin/tool\n`,
    'utf8',
  );
  writeFileSync(
    join(sourceRoot, 'alpha', 'payload.txt'),
    `${marker}:${resourcesPlaceholder}`,
    'utf8',
  );
  writeFileSync(join(sourceRoot, 'beta', 'SKILL.md'), `# beta ${marker}\n`, 'utf8');
  writeFileSync(join(sourceRoot, 'docs-only', 'README.md'), `# docs ${marker}\n`, 'utf8');
}

async function loadModules(): Promise<{
  settingsStore: typeof import('@main/store/settings-store').settingsStore;
  getCodexSkillExtraRootsForSession: typeof import('./skills-installer').getCodexSkillExtraRootsForSession;
  setFilesystem: typeof import('./skills-installer').__setSkillsMirrorFilesystemForTests;
  syncSkills: typeof import('./skills-installer').syncSkills;
}> {
  const [settingsModule, installer] = await Promise.all([
    import('@main/store/settings-store'),
    import('./skills-installer'),
  ]);
  settingsModule.settingsStore.set('injectAgentDeckCodexSkills', true);
  return {
    settingsStore: settingsModule.settingsStore,
    getCodexSkillExtraRootsForSession: installer.getCodexSkillExtraRootsForSession,
    setFilesystem: installer.__setSkillsMirrorFilesystemForTests,
    syncSkills: installer.syncSkills,
  };
}

function getMirrorOperationArtifacts(): string[] {
  if (!existsSync(userDataPath)) return [];
  return readdirSync(userDataPath).filter((entry) =>
    /^\.codex-agent-deck-skills\.(?:staging|backup)-/.test(entry),
  );
}

function cleanupFixture(): void {
  rmSync(sourceRoot, { recursive: true, force: true });
  for (const path of [mirrorRoot, `${mirrorRoot}.versions`, `${mirrorRoot}.sessions`]) rmSync(path, { recursive: true, force: true });
  for (const artifact of getMirrorOperationArtifacts()) {
    rmSync(join(userDataPath, artifact), { recursive: true, force: true });
  }
}

describe('Codex bundled skill snapshots', () => {
  beforeEach(() => { vi.resetModules(); cleanupFixture(); writeSkillsSource(); });
  afterEach(cleanupFixture);

  it('publishes transformed Markdown and preserves non-Markdown payloads', async () => {
    const { syncSkills, getCodexSkillExtraRootsForSession: roots } = await loadModules();
    expect(syncSkills()).toEqual(['alpha', 'beta']);
    const [path] = roots('session-a');
    expect(path).toContain(`${mirrorRoot}.versions/`);
    expect(readFileSync(join(path!, 'alpha', 'SKILL.md'), 'utf8')).toContain(`${join(appPath, 'resources')}/bin/tool`);
    expect(readFileSync(join(path!, 'alpha', 'payload.txt'), 'utf8')).toBe(`v1:${resourcesPlaceholder}`);
  });

  it('pins existing and resumed sessions across source updates and disablement', async () => {
    const { settingsStore, getCodexSkillExtraRootsForSession: roots } = await loadModules();
    const old = roots('session-a');
    writeSkillsSource('v2');
    const fresh = roots('session-b');
    expect(fresh).not.toEqual(old);
    expect(roots('session-a')).toEqual(old);
    settingsStore.set('injectAgentDeckCodexSkills', false);
    expect(roots('session-c')).toEqual([]);
    expect(roots('session-a')).toEqual(old);
    expect(readFileSync(join(old[0]!, 'alpha', 'SKILL.md'), 'utf8')).toContain('v1');
    vi.resetModules();
    const resumed = await loadModules();
    expect(resumed.getCodexSkillExtraRootsForSession('session-a')).toEqual(old);
  });

  it('retains legacy paths when copying or publication fails', async () => {
    const { syncSkills, setFilesystem, getCodexSkillExtraRootsForSession: roots } = await loadModules();
    const old = roots('session-a');
    mkdirSync(mirrorRoot, { recursive: true });
    writeFileSync(join(mirrorRoot, 'legacy.txt'), 'history');
    writeSkillsSource('v2');
    setFilesystem({ renameSync: () => { throw new Error('disk failure'); } });
    expect(syncSkills()).toBeNull();
    expect(roots('session-a')).toEqual(old);
    expect(readFileSync(join(old[0]!, 'alpha', 'SKILL.md'), 'utf8')).toContain('v1');
    expect(readFileSync(join(mirrorRoot, 'legacy.txt'), 'utf8')).toBe('history');
    expect(readdirSync(`${mirrorRoot}.versions`).some(name => name.startsWith('.staging-'))).toBe(false);
  });

  it('uses one publication for identical content and unique staging for reentry', async () => {
    const { syncSkills, setFilesystem } = await loadModules();
    let nested = false;
    let copies = 0;
    setFilesystem({ cpSync: ((from, to, options) => {
      copies++;
      if (!nested) { nested = true; expect(syncSkills()).toEqual(['alpha', 'beta']); }
      return cpSync(from, to, options);
    }) as typeof cpSync });
    expect(syncSkills()).toEqual(['alpha', 'beta']);
    expect(syncSkills()).toEqual(['alpha', 'beta']);
    expect(copies).toBe(2);
    expect(readdirSync(`${mirrorRoot}.versions`)).toHaveLength(1);
  });

  it('fails closed on corrupted snapshots without overwriting selected paths', async () => {
    const { syncSkills, getCodexSkillExtraRootsForSession: roots } = await loadModules();
    const [path] = roots('session-a');
    writeFileSync(join(path!, 'alpha', 'SKILL.md'), '# damaged');
    expect(syncSkills()).toBeNull();
    expect(readFileSync(join(path!, 'alpha', 'SKILL.md'), 'utf8')).toBe('# damaged');
  });

  it('allows pinned history to resume when the source is unavailable', async () => {
    const { syncSkills, getCodexSkillExtraRootsForSession: roots } = await loadModules();
    const old = roots('session-a');
    rmSync(sourceRoot, { recursive: true });
    expect(syncSkills()).toBeNull();
    expect(roots('session-a')).toEqual(old);
    expect(() => roots('session-b')).toThrow();
  });
});
