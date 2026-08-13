import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PROVIDER_SESSION_CATALOG_FILE,
  projectProviderSessionFiles,
} from '@hosts/provider-state/provider-session-projection';

import { resolveServerCoreProviderSettings } from './provider-settings';
import { resolveServerCoreSessionCreateCatalog } from './session-create-catalog';

const settings = resolveServerCoreProviderSettings({});
const roots: string[] = [];

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'server-core-create-catalog-')));
  roots.push(root);
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  return { destination, source };
}

function sourceFile(root: string, relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
}

function projectedCatalog(root: string, value: unknown): void {
  sourceFile(root, PROVIDER_SESSION_CATALOG_FILE, `${JSON.stringify(value)}\n`);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Server Core derived session creation catalog', () => {
  it('uses provider-independent defaults when no derived snapshot exists', () => {
    const { destination } = fixture();
    const catalog = resolveServerCoreSessionCreateCatalog(destination, settings);
    expect(catalog.get('claude-code')).toMatchObject({
      providers: [],
      defaults: { provider: '', model: '', thinking: 'high' },
    });
    expect(catalog.get('grok-build')).toMatchObject({
      providers: [],
      defaults: { model: 'grok-4.5', sessionMode: 'default' },
    });
  });

  it('loads safe defaults and provider-specific models from one trusted projection', () => {
    const { destination, source } = fixture();
    sourceFile(source, '.claude/settings.json', JSON.stringify({ model: 'claude-native' }));
    sourceFile(source, '.claude/gateways/team.json', JSON.stringify({
      env: { ANTHROPIC_MODEL: 'gateway-sonnet', ANTHROPIC_AUTH_TOKEN: 'private-token' },
    }));
    sourceFile(source, '.codex/config.toml', [
      'model = "gpt-5.6"',
      'model_provider = "team"',
      'model_reasoning_effort = "xhigh"',
      '[model_providers.team]',
      'name = "Team"',
    ].join('\n'));
    projectProviderSessionFiles(source, destination);

    const catalog = resolveServerCoreSessionCreateCatalog(destination, settings);
    expect(catalog.get('claude-code')).toMatchObject({
      providers: ['team'],
      defaults: { provider: '', model: 'claude-native', thinking: 'high' },
    });
    expect(catalog.get('claude-code', 'team')).toMatchObject({
      defaults: { provider: 'team', model: 'gateway-sonnet', thinking: 'high' },
    });
    expect(catalog.get('codex-cli')).toMatchObject({
      providers: ['team'],
      defaults: {
        provider: 'team',
        model: 'gpt-5.6',
        thinking: 'xhigh',
        approvalPolicy: 'never',
      },
    });
  });

  it('rejects secret-shaped derived values', () => {
    const { destination } = fixture();
    projectedCatalog(destination, {
      schemaVersion: 2,
      adapters: [{
        adapterId: 'codex-cli',
        providers: [],
        provider: '',
        thinking: 'high',
        approvalPolicy: 'never',
        model: 'sk-must-not-cross',
      }],
    });
    expect(() => resolveServerCoreSessionCreateCatalog(destination, settings))
      .toThrow('provider session projection');
  });

  it('rejects unknown derived snapshot fields', () => {
    const { destination } = fixture();
    projectedCatalog(destination, {
      schemaVersion: 2,
      adapters: [{
        adapterId: 'codex-cli',
        providers: [],
        provider: '',
        thinking: 'high',
        approvalPolicy: 'never',
        model: 'gpt-5.6',
        token: 'private',
      }],
    });
    expect(() => resolveServerCoreSessionCreateCatalog(destination, settings))
      .toThrow('provider session projection');
  });
});
