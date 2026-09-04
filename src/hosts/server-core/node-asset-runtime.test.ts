import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  issueRemoteOwnerGrantClaim,
  type AuthenticatedClientAccessContext,
  type CoreMethod,
  type JsonValue,
} from '@contracts/index';
import type { DaemonCoreRuntime, DaemonRequestInput } from '@hosts/daemon';
import { resolveServerCoreProviderSettings } from './provider-settings';
import { ServerCoreNodeAssetCatalog } from './node-asset-catalog';
import { ServerCoreNodeAssetRuntime } from './node-asset-runtime';
import { resolveServerCoreSpawnAgent } from './spawn-agent-runtime';

function fixtures(): { contents: string; home: string; state: string } {
  const root = mkdtempSync(join(tmpdir(), 'agent-deck-node-assets-'));
  const contents = join(root, 'Contents');
  const resources = join(contents, 'Resources');
  for (const adapter of ['claude', 'codex', 'grok']) {
    const config = join(resources, `${adapter}-config`);
    const plugin = join(config, 'agent-deck-plugin');
    mkdirSync(join(plugin, 'skills', 'sample'), { recursive: true });
    mkdirSync(join(plugin, 'agents'), { recursive: true });
    writeFileSync(join(plugin, 'skills', 'sample', 'SKILL.md'), '---\nname: sample\ndescription: sample skill\n---\n');
    const agent = adapter === 'codex'
      ? 'name = "sample"\ndescription = "sample agent"\ndeveloper_instructions = "review"\n'
      : '---\nname: sample\ndescription: sample agent\n---\nreview\n';
    writeFileSync(join(plugin, 'agents', `sample.${adapter === 'codex' ? 'toml' : 'md'}`), agent);
    writeFileSync(
      join(config, adapter === 'claude' ? 'CLAUDE.md' : adapter === 'codex' ? 'CODEX_AGENTS.md' : 'GROK_AGENTS.md'),
      `# ${adapter}\n`,
    );
  }
  mkdirSync(
    join(resources, 'claude-config', 'agent-deck-plugin', '.claude-plugin'),
    { recursive: true },
  );
  writeFileSync(
    join(resources, 'claude-config', 'agent-deck-plugin', '.claude-plugin', 'plugin.json'),
    '{}',
    { flag: 'w' },
  );
  const home = join(root, 'home');
  const state = join(root, 'state');
  mkdirSync(home);
  mkdirSync(state);
  const userPlugin = join(home, '.claude', 'plugins', 'demo');
  mkdirSync(join(userPlugin, '.claude-plugin'), { recursive: true });
  mkdirSync(join(userPlugin, 'agents'), { recursive: true });
  writeFileSync(
    join(userPlugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'demo' }),
  );
  writeFileSync(
    join(userPlugin, 'agents', 'sample.md'),
    '---\nname: sample\ndescription: Worker plugin agent\n---\nplugin body\n',
  );
  return { contents, home, state };
}

const access: AuthenticatedClientAccessContext = {
  kind: 'authenticated-client',
  topology: 'full',
  instanceId: 'instance-a',
  clientId: 'desktop-a',
  transport: 'ssh',
  connectionScope: 'credential-a',
  authority: 'owner-equivalent',
  surface: 'desktop',
  grant: issueRemoteOwnerGrantClaim('desktop'),
};

function input(method: CoreMethod, params: Record<string, JsonValue>): DaemonRequestInput {
  return {
    access,
    requestId: `request:${method}`,
    method,
    params,
    idempotencyKey: null,
    expectedRevision: null,
    deadlineAt: null,
    signal: new AbortController().signal,
  };
}

describe('ServerCoreNodeAssetRuntime', () => {
  it('lists and reads only Worker-owned packaged resources', async () => {
    const paths = fixtures();
    const settings = resolveServerCoreProviderSettings({
      providerSettings: {
        bundledAgentRuntimeOverrides: {
          'claude-code:sample': {
            model: 'full-review-model',
            thinking: 'max',
            provider: 'full-gateway',
          },
          'codex-cli:sample': {
            model: 'full-codex-model',
            thinking: 'ultra',
            provider: 'full-codex-provider',
          },
          'grok-build:sample': {
            model: 'full-grok-model',
            thinking: 'xhigh',
          },
        },
      },
    });
    const catalog = ServerCoreNodeAssetCatalog.create({
      runtimeReadRoots: [paths.contents],
      stateDirectory: paths.state,
      settings,
    });
    expect(catalog).not.toBeNull();
    expect(resolveServerCoreSpawnAgent(catalog, 'claude-code', 'sample')).toMatchObject({
      defaults: {
        model: 'full-review-model', thinking: 'max', provider: 'full-gateway',
      },
      create: { adapterId: 'claude-code', claudeAgentName: 'sample' },
    });
    expect(resolveServerCoreSpawnAgent(catalog, 'codex-cli', 'sample')).toMatchObject({
      defaults: {
        model: 'full-codex-model', thinking: 'ultra', provider: 'full-codex-provider',
      },
      create: {
        adapterId: 'codex-cli',
        developerInstructions: expect.stringContaining('review'),
      },
    });
    expect(resolveServerCoreSpawnAgent(catalog, 'grok-build', 'sample')).toMatchObject({
      defaults: { model: 'full-grok-model', thinking: 'xhigh' },
      create: {
        adapterId: 'grok-build', grokAgentName: 'sample', grokAgentSource: 'bundled',
      },
    });
    const base: DaemonCoreRuntime = {
      supportedMethods: [] as CoreMethod[],
      start: async () => undefined,
      stop: async () => undefined,
      currentRevision: () => 7,
      execute: () => { throw new Error('unexpected base request'); },
    };
    const runtime = new ServerCoreNodeAssetRuntime(base, catalog!, () => 7);
    const listed = await runtime.execute(input('node.assets.catalog.list', {}));
    expect(listed.result).toMatchObject({ revision: 1 });
    const assets = (listed.result as { assets: Array<{
      adapterId: string;
      kind: string;
      source: string;
      name: string;
      qualifiedName: string;
      location: string;
      model: string | null;
      runtimeDefaults: { model: string | null } | null;
      runtimeOverride: { model: string | null } | null;
    }> }).assets;
    expect(assets.filter((asset) => asset.name === 'sample')).toHaveLength(6);
    expect(assets.every((asset) => asset.source === 'bundled')).toBe(true);

    const bundledSkill = assets.find((asset) =>
      asset.adapterId === 'codex-cli' && asset.kind === 'skill' && asset.source === 'bundled');
    expect(bundledSkill).toBeTruthy();
    const content = await runtime.execute(input('node.assets.content', {
      adapterId: bundledSkill!.adapterId,
      kind: bundledSkill!.kind,
      source: bundledSkill!.source,
      name: bundledSkill!.name,
      qualifiedName: bundledSkill!.qualifiedName,
      location: bundledSkill!.location,
    }));
    expect((content.result as { content: string }).content).toContain('sample skill');
    expect(assets.find((asset) =>
      asset.qualifiedName === 'agent-deck:claude-code:sample')).toMatchObject({
      model: 'full-review-model',
      runtimeDefaults: { model: null },
      runtimeOverride: { model: 'full-review-model' },
    });
    const convention = await runtime.execute(input('node.assets.convention', {
      adapterId: 'claude-code',
    }));
    expect((convention.result as { content: string }).content).toContain('# claude');
  });

  it('does not enumerate Provider Home assets', () => {
    const paths = fixtures();
    const catalog = ServerCoreNodeAssetCatalog.create({
      runtimeReadRoots: [paths.contents],
      stateDirectory: paths.state,
      settings: resolveServerCoreProviderSettings({}),
    });
    expect(catalog).not.toBeNull();
    const listed = catalog!.list(1);
    expect(listed.assets).toHaveLength(6);
    expect(listed.assets.every((asset) => asset.source === 'bundled')).toBe(true);
    expect(listed.assets.some((asset) => asset.qualifiedName === 'plugin:demo/sample')).toBe(false);
    expect(listed.assetsTruncated).toBe(false);
  });
});
