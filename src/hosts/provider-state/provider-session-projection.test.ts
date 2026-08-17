import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PROVIDER_SESSION_CATALOG_FILE,
  projectProviderSessionFiles,
  syncProviderSessionFiles,
} from './provider-session-projection';

const roots: string[] = [];

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provider-session-projection-')));
  roots.push(root);
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  return { destination, source };
}

function sourceFile(root: string, relativePath: string, content: string): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('provider session projection', () => {
  it('projects runtime definitions while keeping the Remote catalog non-secret', () => {
    const { destination, source } = fixture();
    sourceFile(source, '.claude/settings.json', JSON.stringify({
      model: 'native-sonnet',
      hooks: { PreToolUse: [{ command: '/private/hook' }] },
    }));
    sourceFile(source, '.claude/gateways/team.json', JSON.stringify({
      env: {
        ANTHROPIC_MODEL: 'gateway-sonnet',
        ANTHROPIC_AUTH_TOKEN: 'private-claude-token',
        CLAUDE_CONFIG_DIR: '/private/claude-root',
      },
      hooks: { PreToolUse: [{ command: '/private/gateway-hook' }] },
    }));
    sourceFile(source, '.codex/config.toml', [
      'model = "gpt-team"',
      'model_provider = "team"',
      'model_reasoning_effort = "max"',
      '[model_providers.team]',
      'name = "Team"',
      'base_url = "https://provider.example.test/v1"',
      'env_key = "TEAM_API_KEY"',
      '[mcp_servers.private]',
      'command = "/private/mcp"',
    ].join('\n'));
    sourceFile(source, '.codex/gateways/team.json', JSON.stringify({
      name: 'large context',
      model_context_window: 1_000_000,
      model_auto_compact_token_limit: 900_000,
      api_key: 'must-not-project',
    }));
    sourceFile(source, '.grok/config.toml', 'model = "grok-team"\n');

    expect(projectProviderSessionFiles(source, destination)).toEqual([
      '.claude/gateways/team.json',
      '.codex/gateways/team.json',
      '.codex/config.toml',
      PROVIDER_SESSION_CATALOG_FILE,
    ]);
    expect(() => readFileSync(join(destination, '.claude', 'settings.json'))).toThrow();
    const gateway = JSON.parse(readFileSync(
      join(destination, '.claude', 'gateways', 'team.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(gateway).toEqual({
      env: {
        ANTHROPIC_MODEL: 'gateway-sonnet',
        ANTHROPIC_AUTH_TOKEN: 'private-claude-token',
      },
    });
    const codex = readFileSync(join(destination, '.codex', 'config.toml'), 'utf8');
    expect(codex).toContain('[model_providers.team]');
    expect(codex).toContain('base_url = "https://provider.example.test/v1"');
    expect(codex).not.toContain('mcp_servers');
    expect(codex).not.toContain('/private/mcp');
    const codexGateway = JSON.parse(readFileSync(
      join(destination, '.codex', 'gateways', 'team.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(codexGateway).toEqual({
      model_context_window: 1_000_000,
      model_auto_compact_token_limit: 900_000,
    });
    expect(JSON.stringify(codexGateway)).not.toContain('must-not-project');
    const catalog = readFileSync(join(destination, PROVIDER_SESSION_CATALOG_FILE), 'utf8');
    expect(catalog).toContain('gateway-sonnet');
    expect(catalog).toContain('gpt-team');
    expect(catalog).toContain('grok-team');
    expect(catalog).toContain('"id": "team"');
    expect(catalog).not.toContain('private-claude-token');
    expect(catalog).not.toContain('provider.example.test');
    expect(catalog).not.toContain('/private');
  });

  it('removes stale projected providers and refreshes the derived snapshot', () => {
    const { destination, source } = fixture();
    const oldGateway = sourceFile(
      source,
      '.claude/gateways/old.json',
      JSON.stringify({ env: { ANTHROPIC_MODEL: 'old-model' } }),
    );
    const codex = sourceFile(
      source,
      '.codex/config.toml',
      'model = "old-codex"\n[model_providers.old]\nname = "Old"\n',
    );
    const oldCodexGateway = sourceFile(
      source,
      '.codex/gateways/old.json',
      JSON.stringify({ model_context_window: 200_000 }),
    );
    projectProviderSessionFiles(source, destination);

    unlinkSync(oldGateway);
    unlinkSync(codex);
    unlinkSync(oldCodexGateway);
    sourceFile(
      source,
      '.claude/gateways/new.json',
      JSON.stringify({ env: { ANTHROPIC_MODEL: 'new-model' } }),
    );
    syncProviderSessionFiles(source, destination);

    expect(() => readFileSync(join(destination, '.claude', 'gateways', 'old.json'))).toThrow();
    expect(readFileSync(join(destination, '.claude', 'gateways', 'new.json'), 'utf8'))
      .toContain('new-model');
    expect(() => readFileSync(join(destination, '.codex', 'config.toml'))).toThrow();
    expect(() => readFileSync(
      join(destination, '.codex', 'gateways', 'old.json'),
    )).toThrow();
    const catalog = readFileSync(join(destination, PROVIDER_SESSION_CATALOG_FILE), 'utf8');
    expect(catalog).toContain('new-model');
    expect(catalog).not.toContain('old-model');
    expect(catalog).not.toContain('old-codex');
  });
});
