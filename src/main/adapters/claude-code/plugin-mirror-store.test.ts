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
  createPluginMirrorStore,
  type PluginMirrorFilesystem,
} from './plugin-mirror-store';

const defaultFilesystem: PluginMirrorFilesystem = {
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

describe('Claude plugin mirror store', () => {
  let fixtureRoot: string;
  let source: string;
  let destination: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'agent-deck-claude-plugin-'));
    source = join(fixtureRoot, 'source');
    destination = join(fixtureRoot, 'live');
    mkdirSync(join(source, '.claude-plugin'), { recursive: true });
    mkdirSync(join(source, 'skills', 'review'), { recursive: true });
    mkdirSync(join(source, 'agents'), { recursive: true });
    writeFileSync(
      join(source, '.claude-plugin', 'plugin.json'),
      '{"name":"agent-deck","version":"test"}',
      'utf8',
    );
    writeFileSync(
      join(source, 'skills', 'review', 'SKILL.md'),
      '# Review\n{{ROOT}}/bin/tool\n',
      'utf8',
    );
    writeFileSync(join(source, 'agents', 'reviewer.md'), '# Reviewer\n', 'utf8');
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function request() {
    return {
      source,
      destination,
      includeSkills: true,
      includeAgents: false,
    };
  }

  it('prepares, transforms, validates, and publishes one filtered mirror', () => {
    const store = createPluginMirrorStore({
      filesystem: defaultFilesystem,
      transformMarkdown: (content) => content.replaceAll('{{ROOT}}', '/resources'),
      operationTag: 'test',
    });

    expect(store.sync(request())).toBe(destination);
    expect(readFileSync(join(destination, 'skills', 'review', 'SKILL.md'), 'utf8')).toBe(
      '# Review\n/resources/bin/tool\n',
    );
    expect(existsSync(join(destination, 'agents'))).toBe(false);
    expect(operationArtifacts()).toEqual([]);
  });

  it('reuses a valid cached publication and reinstalls a corrupted live manifest', () => {
    let copyAttempts = 0;
    const store = createPluginMirrorStore({
      filesystem: {
        ...defaultFilesystem,
        cpSync: ((from, to, options) => {
          copyAttempts += 1;
          return cpSync(from, to, options);
        }) as typeof cpSync,
      },
      transformMarkdown: (content) => content,
      operationTag: 'test',
    });

    expect(store.sync(request())).toBe(destination);
    expect(store.sync(request())).toBe(destination);
    expect(copyAttempts).toBe(1);

    writeFileSync(join(destination, '.claude-plugin', 'plugin.json'), '{', 'utf8');
    expect(store.sync(request())).toBe(destination);
    expect(copyAttempts).toBe(2);
    expect(operationArtifacts()).toEqual([]);
  });

  it('rolls a failed replacement back to the previous complete live mirror', () => {
    const initial = createPluginMirrorStore({
      filesystem: defaultFilesystem,
      transformMarkdown: (content) => content,
      operationTag: 'initial',
    });
    expect(initial.sync(request())).toBe(destination);
    const liveSkill = join(destination, 'skills', 'review', 'SKILL.md');
    writeFileSync(liveSkill, '# old reader\n', 'utf8');
    writeFileSync(join(source, 'skills', 'review', 'SKILL.md'), '# replacement\n', 'utf8');
    const diagnostic = vi.fn();
    const replacement = createPluginMirrorStore({
      filesystem: {
        ...defaultFilesystem,
        renameSync: ((from, to) => {
          if (String(from).includes('.live.staging-') && String(to) === destination) {
            throw new Error('publish failed');
          }
          return renameSync(from, to);
        }) as typeof renameSync,
      },
      transformMarkdown: (content) => content,
      diagnostic,
      operationTag: 'replacement',
    });

    expect(replacement.sync(request())).toBeNull();
    expect(readFileSync(liveSkill, 'utf8')).toBe('# old reader\n');
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'install-failed',
      destination,
    }));
    expect(operationArtifacts()).toEqual([]);
  });

  it('fails closed with a structured diagnostic when the source is missing', () => {
    const diagnostic = vi.fn();
    const store = createPluginMirrorStore({
      filesystem: defaultFilesystem,
      transformMarkdown: (content) => content,
      diagnostic,
      operationTag: 'test',
    });
    rmSync(source, { recursive: true, force: true });

    expect(store.sync(request())).toBeNull();
    expect(existsSync(destination)).toBe(false);
    expect(diagnostic).toHaveBeenCalledWith({ kind: 'source-missing', source });
  });

  function operationArtifacts(): string[] {
    return readdirSync(fixtureRoot).filter((entry) => /^\.live\.(?:staging|backup)-/.test(entry));
  }
});
