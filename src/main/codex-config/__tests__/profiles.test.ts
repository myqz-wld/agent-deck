import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCodexConfigProfileId,
  codexConfigProfilePath,
  listCodexConfigProfiles,
  resolveCodexConfigProfile,
} from '../profiles';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Codex native config profiles', () => {
  it('discovers independent profile files and ignores base, invalid, and directory entries', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'config.toml'), 'model = "base"\n', 'utf8');
    writeFileSync(join(root, 'openrouter.config.toml'), 'model_provider = "openrouter"\n', 'utf8');
    writeFileSync(join(root, 'team.alpha.config.toml'), 'model = "gpt-team"\n', 'utf8');
    writeFileSync(join(root, '-unsafe.config.toml'), 'model = "unsafe"\n', 'utf8');
    writeFileSync(join(root, 'not-a-profile.toml'), 'model = "ignored"\n', 'utf8');
    mkdirSync(join(root, 'directory.config.toml'));

    expect(listCodexConfigProfiles({ codexHome: root })).toEqual([
      {
        id: 'openrouter',
        configPath: join(root, 'openrouter.config.toml'),
      },
      {
        id: 'team.alpha',
        configPath: join(root, 'team.alpha.config.toml'),
      },
    ]);
  });

  it('accepts a profile-file symlink and resolves an existing profile', () => {
    const root = tempRoot();
    const target = join(root, 'target.toml');
    writeFileSync(target, 'model = "linked"\n', 'utf8');
    symlinkSync(target, join(root, 'linked.config.toml'));

    expect(listCodexConfigProfiles({ codexHome: root })).toEqual([
      {
        id: 'linked',
        configPath: join(root, 'linked.config.toml'),
      },
    ]);
    expect(resolveCodexConfigProfile(' linked ', { codexHome: root })).toEqual({
      id: 'linked',
      configPath: join(root, 'linked.config.toml'),
    });
  });

  it('validates safe names and requires an existing profile file', () => {
    const root = tempRoot();
    expect(() => assertCodexConfigProfileId('../escape')).toThrow(
      /Invalid Codex config profile/,
    );
    expect(codexConfigProfilePath('team_one', { codexHome: root })).toBe(
      join(root, 'team_one.config.toml'),
    );
    expect(() => resolveCodexConfigProfile('missing', { codexHome: root })).toThrow(
      /was not found/,
    );
    expect(resolveCodexConfigProfile('', { codexHome: root })).toBeNull();
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-deck-codex-profiles-'));
  roots.push(root);
  return root;
}
