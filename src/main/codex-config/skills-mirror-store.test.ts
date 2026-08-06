import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSkillsMirrorStore,
  type SkillsMirrorFilesystem,
  type SkillsMirrorStore,
} from './skills-mirror-store';

const defaultFilesystem: SkillsMirrorFilesystem = {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
};

describe('Codex skills mirror store', () => {
  let fixtureRoot: string;
  let source: string;
  let destination: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'agent-deck-codex-skills-store-'));
    source = join(fixtureRoot, 'source');
    destination = join(fixtureRoot, 'live');
    mkdirSync(join(source, 'alpha'), { recursive: true });
    writeFileSync(
      join(source, 'alpha', 'SKILL.md'),
      '# Alpha\n{{ROOT}}/bin/tool\n',
      'utf8',
    );
    writeFileSync(join(source, 'alpha', 'payload.txt'), '{{ROOT}}', 'utf8');
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function request() {
    return { source, destination };
  }

  function createStore(
    filesystem: SkillsMirrorFilesystem = defaultFilesystem,
    diagnostic?: Parameters<typeof createSkillsMirrorStore>[0]['diagnostic'],
  ): SkillsMirrorStore {
    return createSkillsMirrorStore({
      filesystem,
      transformMarkdown: (content) => content.replaceAll('{{ROOT}}', '/resources'),
      diagnostic,
      operationTag: 'test',
    });
  }

  it('publishes a transformed manifest mirror and repairs content tampering', () => {
    let copyAttempts = 0;
    const store = createStore({
      ...defaultFilesystem,
      cpSync: ((from, to, options) => {
        copyAttempts += 1;
        return cpSync(from, to, options);
      }) as typeof cpSync,
    });

    expect(store.sync(request())).toEqual(['alpha']);
    expect(store.sync(request())).toEqual(['alpha']);
    expect(copyAttempts).toBe(1);
    expect(readFileSync(join(destination, 'alpha', 'SKILL.md'), 'utf8')).toContain(
      '/resources/bin/tool',
    );
    expect(readFileSync(join(destination, 'alpha', 'payload.txt'), 'utf8')).toBe('{{ROOT}}');

    writeFileSync(join(destination, 'alpha', 'SKILL.md'), '# tampered\n', 'utf8');
    expect(store.sync(request())).toEqual(['alpha']);
    expect(copyAttempts).toBe(2);
    expect(operationArtifacts()).toEqual([]);
  });

  it('uses unique sibling staging trees for a synchronous reentrant publisher', () => {
    let store: SkillsMirrorStore;
    let shouldReenter = true;
    let nestedResult: string[] | null | undefined;
    let copyAttempts = 0;
    store = createStore({
      ...defaultFilesystem,
      cpSync: ((from, to, options) => {
        copyAttempts += 1;
        if (shouldReenter) {
          shouldReenter = false;
          nestedResult = store.sync(request());
        }
        return cpSync(from, to, options);
      }) as typeof cpSync,
    });

    expect(store.sync(request())).toEqual(['alpha']);
    expect(nestedResult).toEqual(['alpha']);
    expect(copyAttempts).toBe(2);
    expect(operationArtifacts()).toEqual([]);
  });

  it('rolls a failed replacement back to the prior valid mirror', () => {
    expect(createStore().sync(request())).toEqual(['alpha']);
    const liveSkill = join(destination, 'alpha', 'SKILL.md');
    const priorManifest = readFileSync(
      join(destination, '.agent-deck-skills-manifest.json'),
      'utf8',
    );
    writeFileSync(join(source, 'alpha', 'SKILL.md'), '# replacement\n', 'utf8');
    const diagnostic = vi.fn();
    const replacement = createStore({
      ...defaultFilesystem,
      renameSync: ((from, to) => {
        if (String(from).includes('.live.staging-') && String(to) === destination) {
          throw new Error('publish failed');
        }
        return renameSync(from, to);
      }) as typeof renameSync,
    }, diagnostic);

    expect(replacement.sync(request())).toBeNull();
    expect(readFileSync(liveSkill, 'utf8')).toContain('# Alpha');
    expect(readFileSync(join(destination, '.agent-deck-skills-manifest.json'), 'utf8')).toBe(
      priorManifest,
    );
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'prepare-failed',
      destination,
    }));
    expect(operationArtifacts()).toEqual([]);
  });

  it('removes an invalid live tree but preserves a valid mirror when the source disappears', () => {
    const store = createStore();
    mkdirSync(join(destination, 'partial'), { recursive: true });
    rmSync(source, { recursive: true, force: true });

    expect(store.sync(request())).toBeNull();
    expect(existsSync(destination)).toBe(false);

    mkdirSync(join(source, 'alpha'), { recursive: true });
    writeFileSync(join(source, 'alpha', 'SKILL.md'), '# Alpha\n', 'utf8');
    expect(store.sync(request())).toEqual(['alpha']);
    const manifest = readFileSync(
      join(destination, '.agent-deck-skills-manifest.json'),
      'utf8',
    );
    rmSync(source, { recursive: true, force: true });
    expect(store.sync(request())).toBeNull();
    expect(readFileSync(join(destination, '.agent-deck-skills-manifest.json'), 'utf8')).toBe(
      manifest,
    );
  });

  function operationArtifacts(): string[] {
    return readdirSync(fixtureRoot).filter((entry) => /^\.live\.(?:staging|backup)-/.test(entry));
  }
});
