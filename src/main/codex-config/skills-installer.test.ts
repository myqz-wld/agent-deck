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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appPath = app.getAppPath();
const userDataPath = app.getPath('userData');
const sourceRoot = join(
  appPath,
  'resources',
  'codex-config',
  'agent-deck-plugin',
  'skills',
);
const mirrorRoot = join(userDataPath, 'codex-agent-deck-skills');
const mirrorManifest = join(mirrorRoot, '.agent-deck-skills-manifest.json');
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
  rmSync(mirrorRoot, { recursive: true, force: true });
  for (const artifact of getMirrorOperationArtifacts()) {
    rmSync(join(userDataPath, artifact), { recursive: true, force: true });
  }
}

describe('Codex bundled skills mirror', () => {
  beforeEach(() => {
    vi.resetModules();
    cleanupFixture();
    writeSkillsSource();
  });

  afterEach(() => {
    cleanupFixture();
  });

  it('publishes a complete fresh mirror with a deterministic manifest and markdown substitution', async () => {
    const { syncSkills } = await loadModules();

    expect(syncSkills()).toEqual(['alpha', 'beta']);
    expect(readFileSync(join(mirrorRoot, 'alpha', 'SKILL.md'), 'utf8')).toContain(
      `${join(appPath, 'resources')}/bin/tool`,
    );
    expect(readFileSync(join(mirrorRoot, 'alpha', 'payload.txt'), 'utf8')).toBe(
      `v1:${resourcesPlaceholder}`,
    );
    const manifest = JSON.parse(readFileSync(mirrorManifest, 'utf8')) as {
      version: number;
      signature: string;
      entries: unknown[];
    };
    expect(manifest.version).toBe(1);
    expect(manifest.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.entries.length).toBeGreaterThan(0);
    expect(getMirrorOperationArtifacts()).toEqual([]);
  });

  it('does not publish a partial mirror and removes staging debris when copying fails', async () => {
    mkdirSync(join(mirrorRoot, 'alpha'), { recursive: true });
    writeFileSync(join(mirrorRoot, 'alpha', 'SKILL.md'), '# legacy partial', 'utf8');
    const { setFilesystem, syncSkills } = await loadModules();
    setFilesystem({
      cpSync: ((source, destination, options) => {
        cpSync(source, destination, options);
        throw new Error('copy failed');
      }) as typeof cpSync,
    });

    expect(syncSkills()).toBeNull();
    expect(existsSync(mirrorRoot)).toBe(false);
    expect(getMirrorOperationArtifacts()).toEqual([]);
  });

  it('treats staged markdown substitution failure as fatal and removes staging debris', async () => {
    const { setFilesystem, syncSkills } = await loadModules();
    setFilesystem({
      readFileSync: ((path: string | Buffer | URL, encoding?: BufferEncoding) => {
        if (
          String(path).includes('.codex-agent-deck-skills.staging-') &&
          String(path).endsWith('SKILL.md')
        ) {
          throw new Error('substitution failed');
        }
        return encoding === 'utf8' ? readFileSync(path, 'utf8') : readFileSync(path);
      }) as typeof readFileSync,
    });

    expect(syncSkills()).toBeNull();
    expect(existsSync(mirrorRoot)).toBe(false);
    expect(getMirrorOperationArtifacts()).toEqual([]);
  });

  it('replaces a partial pre-existing mirror instead of trusting its SKILL.md', async () => {
    mkdirSync(join(mirrorRoot, 'alpha'), { recursive: true });
    writeFileSync(join(mirrorRoot, 'alpha', 'SKILL.md'), '# partial', 'utf8');
    const { syncSkills } = await loadModules();

    expect(syncSkills()).toEqual(['alpha', 'beta']);
    expect(readFileSync(join(mirrorRoot, 'alpha', 'SKILL.md'), 'utf8')).toContain('# alpha v1');
    expect(existsSync(join(mirrorRoot, 'beta', 'SKILL.md'))).toBe(true);
    expect(existsSync(mirrorManifest)).toBe(true);
    expect(getMirrorOperationArtifacts()).toEqual([]);
  });

  it('rebuilds a stale mirror when current source content changes', async () => {
    const { setFilesystem, syncSkills } = await loadModules();
    expect(syncSkills()).toEqual(['alpha', 'beta']);
    const oldManifest = readFileSync(mirrorManifest, 'utf8');
    writeSkillsSource('v2');
    let copyAttempts = 0;
    setFilesystem({
      cpSync: ((source, destination, options) => {
        copyAttempts += 1;
        return cpSync(source, destination, options);
      }) as typeof cpSync,
    });

    expect(syncSkills()).toEqual(['alpha', 'beta']);
    expect(copyAttempts).toBe(1);
    expect(readFileSync(join(mirrorRoot, 'alpha', 'SKILL.md'), 'utf8')).toContain('# alpha v2');
    expect(readFileSync(mirrorManifest, 'utf8')).not.toBe(oldManifest);
    expect(getMirrorOperationArtifacts()).toEqual([]);
  });

  it('keeps the old complete mirror readable until the staged replacement is ready', async () => {
    const { setFilesystem, syncSkills } = await loadModules();
    expect(syncSkills()).toEqual(['alpha', 'beta']);
    writeSkillsSource('v2');
    let readerSawOldMirrorDuringCopy = false;
    let stagedTreeWasCompleteAtPublish = false;
    setFilesystem({
      cpSync: ((source, destination, options) => {
        const result = cpSync(source, destination, options);
        readerSawOldMirrorDuringCopy = readFileSync(
          join(mirrorRoot, 'alpha', 'SKILL.md'),
          'utf8',
        ).includes('# alpha v1');
        return result;
      }) as typeof cpSync,
      renameSync: ((from, to) => {
        if (
          String(from).includes('.codex-agent-deck-skills.staging-') &&
          String(to) === mirrorRoot
        ) {
          stagedTreeWasCompleteAtPublish =
            readFileSync(join(String(from), 'alpha', 'SKILL.md'), 'utf8').includes('# alpha v2') &&
            existsSync(join(String(from), '.agent-deck-skills-manifest.json'));
        }
        return renameSync(from, to);
      }) as typeof renameSync,
    });

    expect(syncSkills()).toEqual(['alpha', 'beta']);
    expect(readerSawOldMirrorDuringCopy).toBe(true);
    expect(stagedTreeWasCompleteAtPublish).toBe(true);
    expect(readFileSync(join(mirrorRoot, 'alpha', 'SKILL.md'), 'utf8')).toContain('# alpha v2');
    expect(getMirrorOperationArtifacts()).toEqual([]);
  });

  it('replaces a mirror whose manifest signature or mirrored content does not validate', async () => {
    const { setFilesystem, syncSkills } = await loadModules();
    expect(syncSkills()).toEqual(['alpha', 'beta']);
    const parsed = JSON.parse(readFileSync(mirrorManifest, 'utf8')) as { signature: string };
    parsed.signature = '0'.repeat(64);
    writeFileSync(mirrorManifest, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    writeFileSync(join(mirrorRoot, 'alpha', 'SKILL.md'), '# tampered', 'utf8');
    let copyAttempts = 0;
    setFilesystem({
      cpSync: ((source, destination, options) => {
        copyAttempts += 1;
        return cpSync(source, destination, options);
      }) as typeof cpSync,
    });

    expect(syncSkills()).toEqual(['alpha', 'beta']);
    expect(copyAttempts).toBe(1);
    expect(readFileSync(join(mirrorRoot, 'alpha', 'SKILL.md'), 'utf8')).toContain('# alpha v1');
    expect(JSON.parse(readFileSync(mirrorManifest, 'utf8'))).not.toMatchObject({
      signature: '0'.repeat(64),
    });
    expect(getMirrorOperationArtifacts()).toEqual([]);
  });

  it('rolls publication failure back to the prior valid mirror without exposing it as current', async () => {
    const {
      getCodexSkillExtraRootsForSession,
      setFilesystem,
      syncSkills,
    } = await loadModules();
    expect(syncSkills()).toEqual(['alpha', 'beta']);
    const priorManifest = readFileSync(mirrorManifest, 'utf8');
    writeSkillsSource('v2');
    setFilesystem({
      renameSync: ((from, to) => {
        if (
          String(from).includes('.codex-agent-deck-skills.staging-') &&
          String(to) === mirrorRoot
        ) {
          throw new Error('publish failed');
        }
        return renameSync(from, to);
      }) as typeof renameSync,
    });

    expect(syncSkills()).toBeNull();
    expect(getCodexSkillExtraRootsForSession()).toEqual([]);
    expect(readFileSync(join(mirrorRoot, 'alpha', 'SKILL.md'), 'utf8')).toContain('# alpha v1');
    expect(readFileSync(mirrorManifest, 'utf8')).toBe(priorManifest);
    expect(getMirrorOperationArtifacts()).toEqual([]);

    setFilesystem();
    writeSkillsSource('v1');
    expect(getCodexSkillExtraRootsForSession()).toEqual([mirrorRoot]);
  });

  it('validates repeated calls and skips copying only while source and mirror still match', async () => {
    const { getCodexSkillExtraRootsForSession, setFilesystem, syncSkills } = await loadModules();
    let copyAttempts = 0;
    setFilesystem({
      cpSync: ((source, destination, options) => {
        copyAttempts += 1;
        return cpSync(source, destination, options);
      }) as typeof cpSync,
    });

    expect(syncSkills()).toEqual(['alpha', 'beta']);
    expect(syncSkills()).toEqual(['alpha', 'beta']);
    expect(getCodexSkillExtraRootsForSession()).toEqual([mirrorRoot]);
    expect(copyAttempts).toBe(1);

    writeFileSync(join(mirrorRoot, 'beta', 'SKILL.md'), '# partial overwrite', 'utf8');
    expect(getCodexSkillExtraRootsForSession()).toEqual([mirrorRoot]);
    expect(copyAttempts).toBe(2);
    expect(readFileSync(join(mirrorRoot, 'beta', 'SKILL.md'), 'utf8')).toContain('# beta v1');
    expect(getMirrorOperationArtifacts()).toEqual([]);
  });

  it('uses unique sibling staging trees when a synchronous call is re-entered', async () => {
    const { setFilesystem, syncSkills } = await loadModules();
    let shouldReenter = true;
    let nestedResult: string[] | null | undefined;
    let copyAttempts = 0;
    setFilesystem({
      cpSync: ((source, destination, options) => {
        copyAttempts += 1;
        if (shouldReenter) {
          shouldReenter = false;
          nestedResult = syncSkills();
        }
        return cpSync(source, destination, options);
      }) as typeof cpSync,
    });

    expect(syncSkills()).toEqual(['alpha', 'beta']);
    expect(nestedResult).toEqual(['alpha', 'beta']);
    expect(copyAttempts).toBe(2);
    expect(readFileSync(join(mirrorRoot, 'alpha', 'SKILL.md'), 'utf8')).toContain('# alpha v1');
    expect(getMirrorOperationArtifacts()).toEqual([]);
  });

  it('returns no extra root when the source disappears while preserving a prior valid mirror', async () => {
    const { getCodexSkillExtraRootsForSession, syncSkills } = await loadModules();
    expect(syncSkills()).toEqual(['alpha', 'beta']);
    const priorManifest = readFileSync(mirrorManifest, 'utf8');
    rmSync(sourceRoot, { recursive: true, force: true });

    expect(syncSkills()).toBeNull();
    expect(getCodexSkillExtraRootsForSession()).toEqual([]);
    expect(readFileSync(mirrorManifest, 'utf8')).toBe(priorManifest);
    expect(getMirrorOperationArtifacts()).toEqual([]);
  });

  it('removes the app-owned mirror when bundled Codex skill injection is disabled', async () => {
    const { settingsStore, syncSkills } = await loadModules();
    expect(syncSkills()).toEqual(['alpha', 'beta']);
    settingsStore.set('injectAgentDeckCodexSkills', false);

    expect(syncSkills()).toEqual([]);
    expect(existsSync(mirrorRoot)).toBe(false);
    expect(getMirrorOperationArtifacts()).toEqual([]);
  });
});
