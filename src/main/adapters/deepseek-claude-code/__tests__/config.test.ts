import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => mockHome.value,
  };
});

describe('Deepseek Claude Code config', () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    vi.resetModules();
    root = mkdtempSync(join(tmpdir(), 'agent-deck-deepseek-config-'));
    home = join(root, 'home');
    mockHome.value = home;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('uses the hyphenated Agent Deck home config path', async () => {
    const { getDeepseekSettingsPath } = await import('../config');

    expect(getDeepseekSettingsPath()).toBe(
      join(home, '.agent-deck', '.deepseek', 'settings.json'),
    );
  });

  it('creates a new default file without reading the legacy underscore path', async () => {
    const legacyPath = join(home, '.agent_deck', '.deepseek', 'settings.json');
    mkdirSync(join(home, '.agent_deck', '.deepseek'), { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'legacy-token' } }, null, 2) + '\n',
      'utf8',
    );

    const { getDeepseekSettingsPath, loadDeepseekClaudeEnv } = await import('../config');

    expect(() => loadDeepseekClaudeEnv()).toThrow(/requires an API key/);
    const newPath = getDeepseekSettingsPath();
    expect(existsSync(newPath)).toBe(true);
    const data = JSON.parse(readFileSync(newPath, 'utf8')) as {
      env: { ANTHROPIC_AUTH_TOKEN: string };
    };
    expect(data.env.ANTHROPIC_AUTH_TOKEN).toBe('');
  });

  it('resolves Claude alias models without requiring a configured token', async () => {
    const { getDeepseekModelForClaudeAlias } = await import('../config');

    expect(getDeepseekModelForClaudeAlias('haiku')).toBe('deepseek-v4-flash');
    expect(getDeepseekModelForClaudeAlias('opus')).toBe('deepseek-v4-pro[1m]');
  });

  it('uses user-configured Claude alias model overrides', async () => {
    const { getDeepseekSettingsPath, getDeepseekModelForClaudeAlias } = await import('../config');
    const settingsPath = getDeepseekSettingsPath();
    mkdirSync(join(settingsPath, '..'), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ haikuModel: 'custom-haiku-model', env: { ANTHROPIC_AUTH_TOKEN: '' } }),
      'utf8',
    );

    expect(getDeepseekModelForClaudeAlias('haiku')).toBe('custom-haiku-model');
  });
});
