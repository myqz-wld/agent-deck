import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SKILLS_MIRROR_MANIFEST_FILENAME,
  assertSkillsMirrorValid,
  createExpectedSkillsMirrorManifest,
  isSkillsMirrorSelfValid,
  isSkillsMirrorValid,
  listSkillsFromManifest,
  parseSkillsMirrorManifest,
  serializeSkillsMirrorManifest,
} from './skills-mirror-manifest';

const filesystem = { readFileSync, readdirSync };
const placeholder = '{{ROOT}}';

describe('Codex skills mirror manifest codec', () => {
  let fixtureRoot: string;
  let sourceDir: string;
  let mirrorDir: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'agent-deck-skills-manifest-'));
    sourceDir = join(fixtureRoot, 'source');
    mirrorDir = join(fixtureRoot, 'mirror');
    mkdirSync(join(sourceDir, 'alpha'), { recursive: true });
    mkdirSync(join(sourceDir, 'docs-only'), { recursive: true });
    writeFileSync(
      join(sourceDir, 'alpha', 'SKILL.md'),
      `# Alpha\n${placeholder}/bin/tool\n`,
      'utf8',
    );
    writeFileSync(join(sourceDir, 'alpha', 'payload.txt'), placeholder, 'utf8');
    writeFileSync(join(sourceDir, 'docs-only', 'README.md'), '# Docs\n', 'utf8');
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function expectedManifest() {
    return createExpectedSkillsMirrorManifest(
      sourceDir,
      filesystem,
      (content) => content.replaceAll(placeholder, '/opt/agent-deck'),
    );
  }

  function publishExpectedMirror(): ReturnType<typeof expectedManifest> {
    const expected = expectedManifest();
    cpSync(sourceDir, mirrorDir, { recursive: true });
    const skillPath = join(mirrorDir, 'alpha', 'SKILL.md');
    writeFileSync(
      skillPath,
      readFileSync(skillPath, 'utf8').replaceAll(placeholder, '/opt/agent-deck'),
      'utf8',
    );
    writeFileSync(
      join(mirrorDir, SKILLS_MIRROR_MANIFEST_FILENAME),
      serializeSkillsMirrorManifest(expected),
      'utf8',
    );
    return expected;
  }

  it('creates a deterministic canonical manifest after markdown-only transformation', () => {
    const manifest = expectedManifest();
    const parsed = parseSkillsMirrorManifest(serializeSkillsMirrorManifest(manifest));

    expect(parsed).toEqual(manifest);
    expect(parsed.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(listSkillsFromManifest(parsed)).toEqual(['alpha']);
    expect(parsed.entries.find((entry) => entry.path === 'alpha/payload.txt')).toMatchObject({
      kind: 'file',
    });
  });

  it('validates a complete mirror and rejects content tampering', () => {
    const expected = publishExpectedMirror();

    expect(() => assertSkillsMirrorValid(mirrorDir, expected, filesystem)).not.toThrow();
    expect(isSkillsMirrorValid(mirrorDir, expected, filesystem)).toBe(true);
    expect(isSkillsMirrorSelfValid(mirrorDir, filesystem)).toBe(true);

    writeFileSync(join(mirrorDir, 'alpha', 'payload.txt'), 'tampered', 'utf8');
    expect(isSkillsMirrorValid(mirrorDir, expected, filesystem)).toBe(false);
    expect(isSkillsMirrorSelfValid(mirrorDir, filesystem)).toBe(false);
  });

  it('rejects unsafe manifest paths and forged signatures', () => {
    const manifest = expectedManifest();
    const unsafe = JSON.parse(serializeSkillsMirrorManifest(manifest)) as {
      entries: Array<{ path: string }>;
    };
    unsafe.entries[0]!.path = '../escape';
    expect(() => parseSkillsMirrorManifest(JSON.stringify(unsafe))).toThrow(
      'invalid skill mirror path',
    );

    const forged = { ...manifest, signature: '0'.repeat(64) };
    expect(() => parseSkillsMirrorManifest(JSON.stringify(forged))).toThrow(
      'invalid skill mirror signature',
    );
  });

  it('rejects a bundled source that collides with the reserved manifest file', () => {
    writeFileSync(
      join(sourceDir, SKILLS_MIRROR_MANIFEST_FILENAME),
      '{}',
      'utf8',
    );

    expect(() => expectedManifest()).toThrow('reserved bundled skill entry');
  });
});
