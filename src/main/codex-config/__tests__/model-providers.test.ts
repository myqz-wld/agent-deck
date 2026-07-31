import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listCodexModelProviders, resolveCodexModelProvider } from '../model-providers';

const roots: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

describe('Codex model providers', () => {
  it('reads native provider ids and labels without resolving or rewriting them', () => {
    const path = tempConfig([
      'model = "qw-pro-5"',
      'model_provider = "fable"',
      '',
      '[model_providers.openai]',
      'name = "OpenAI"',
      '',
      '[model_providers.fable]',
      'name = "Fable Gateway"',
      'base_url = "https://api.appintheloop.com/v1"',
    ].join('\n'));

    expect(listCodexModelProviders(path)).toEqual([
      { id: 'fable', name: 'Fable Gateway', configuredAsTopLevelDefault: true },
      { id: 'openai', name: 'OpenAI', configuredAsTopLevelDefault: false },
    ]);
  });

  it('supports quoted ids and includes an undeclared top-level selection', () => {
    const path = tempConfig([
      'model_provider = "native-default"',
      '',
      '[model_providers."custom.gateway"]',
      'name = "Custom Gateway"',
    ].join('\n'));

    expect(listCodexModelProviders(path)).toEqual([
      { id: 'native-default', configuredAsTopLevelDefault: true },
      { id: 'custom.gateway', name: 'Custom Gateway', configuredAsTopLevelDefault: false },
    ]);
  });

  it('uses CODEX_HOME and validates only providers present in native config', () => {
    const root = tempRoot();
    process.env.CODEX_HOME = root;
    writeFileSync(join(root, 'config.toml'), '[model_providers.team]\nname = "Team"\n', 'utf8');

    expect(resolveCodexModelProvider(' team ')).toMatchObject({ id: 'team' });
    expect(() => resolveCodexModelProvider('missing')).toThrow(/model_provider.*不存在/);
    expect(resolveCodexModelProvider('')).toBeNull();
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-deck-codex-providers-'));
  roots.push(root);
  return root;
}

function tempConfig(content: string): string {
  const root = tempRoot();
  const path = join(root, 'config.toml');
  writeFileSync(path, content, 'utf8');
  return path;
}
