import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectProviderSessionFiles } from '@hosts/provider-state/provider-session-projection';
import { getAdapterRuntimeProfile } from '@main/adapters/runtime-profiles';
import type { AgentAdapter } from '@main/adapters/types';
import type { SessionAdapterId } from '@shared/types';

import {
  closeSpawnHarnessDatabases,
  harness,
} from './mcp-session-spawn.test-fixtures';
import { resolveServerCoreProviderSettings } from './provider-settings';
import { ServerCoreSessionCreateCapabilities } from './session-create-capabilities';
import { resolveServerCoreSessionCreateCatalog } from './session-create-catalog';

const roots: string[] = [];

function adapter(adapterId: SessionAdapterId): AgentAdapter {
  const profile = getAdapterRuntimeProfile(adapterId);
  return {
    id: adapterId,
    displayName: profile.displayName,
    capabilities: { ...profile.capabilities },
    createSession: vi.fn(),
  } as unknown as AgentAdapter;
}

function realCapabilities(): ServerCoreSessionCreateCapabilities {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-agent-capabilities-')));
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const providerHome = join(root, 'provider-home');
  const providerSource = join(root, 'provider-source');
  mkdirSync(workspaceRoot);
  mkdirSync(providerHome, { mode: 0o700 });
  mkdirSync(join(providerSource, '.claude', 'gateways'), { recursive: true, mode: 0o700 });
  mkdirSync(join(providerSource, '.codex'), { recursive: true, mode: 0o700 });
  writeFileSync(join(providerSource, '.claude', 'gateways', 'deepseek.json'), JSON.stringify({
    env: { ANTHROPIC_MODEL: 'gateway-default' },
  }));
  writeFileSync(join(providerSource, '.codex', 'config.toml'), [
    'model = "native-default"',
    'model_provider = "team"',
    '[model_providers.team]',
    'name = "Team"',
    '[model_providers.openai]',
    'name = "OpenAI"',
  ].join('\n'));
  projectProviderSessionFiles(providerSource, providerHome);
  const adapters = new Map<SessionAdapterId, AgentAdapter>([
    ['claude-code', adapter('claude-code')],
    ['codex-cli', adapter('codex-cli')],
  ]);
  const settings = resolveServerCoreProviderSettings({});
  return new ServerCoreSessionCreateCapabilities({
    metadata: { currentRevision: () => 1 },
    projects: [],
    catalog: resolveServerCoreSessionCreateCatalog(providerHome, settings),
    registry: {
      get: (adapterId) => adapters.get(adapterId as SessionAdapterId),
      isReady: (adapterId) => adapters.has(adapterId as SessionAdapterId),
    },
    settings,
    workspaceRoot: realpathSync(workspaceRoot),
  });
}

afterEach(() => {
  closeSpawnHarnessDatabases();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ServerCoreMcpSessionSpawner Agent capability selection', () => {
  it('validates a Claude Agent against its configured gateway', async () => {
    const capabilities = realCapabilities();
    const state = harness({
      capabilities,
      agents: {
        resolveBundledAgent: (adapterId, agentName) => adapterId === 'claude-code' &&
          agentName === 'reviewer-claude' ? {
            dto: {
              adapterId,
              kind: 'agent',
              source: 'bundled',
              name: agentName,
              qualifiedName: 'agent-deck:claude-code:reviewer-claude',
              description: 'Reviewer',
              location: '应用内置/agents/reviewer-claude.md',
              tools: null,
              model: 'deepseek-v4-flash[1m]',
              thinking: 'max',
              provider: 'deepseek',
              origin: null,
              pluginName: null,
              runtimeName: null,
              runtimeDefaults: { model: 'sonnet', thinking: 'high', provider: null },
              runtimeOverride: {
                model: 'deepseek-v4-flash[1m]', thinking: 'max', provider: 'deepseek',
              },
            },
            content: [
              '---',
              'name: reviewer-claude',
              'description: Reviewer',
              '---',
              'Review this batch.',
            ].join('\n'),
          } : null,
      },
    });

    await expect(state.spawner.spawn('caller', {
      adapter: 'claude-code',
      agentName: 'reviewer-claude',
      cwd: '.',
      prompt: 'Inspect',
    })).resolves.toMatchObject({ agentName: 'reviewer-claude' });
    expect(state.describe).toHaveBeenCalledWith(expect.objectContaining({ provider: 'deepseek' }));
    expect(state.createSpawnSession.mock.calls[0]![0].params.options).toMatchObject({
      model: 'deepseek-v4-flash[1m]',
      thinking: 'max',
      provider: 'deepseek',
    });
  });

  it('validates a Codex Agent against its non-default provider', async () => {
    const capabilities = realCapabilities();
    const state = harness({
      capabilities,
      agents: {
        resolveBundledAgent: (adapterId, agentName) => adapterId === 'codex-cli' &&
          agentName === 'reviewer-codex' ? {
            dto: {
              adapterId,
              kind: 'agent',
              source: 'bundled',
              name: agentName,
              qualifiedName: 'agent-deck:codex-cli:reviewer-codex',
              description: 'Reviewer',
              location: '应用内置/agents/reviewer-codex.toml',
              tools: null,
              model: 'agent-model',
              thinking: 'xhigh',
              provider: 'openai',
              origin: null,
              pluginName: null,
              runtimeName: null,
              runtimeDefaults: { model: 'native-default', thinking: 'high', provider: null },
              runtimeOverride: { model: 'agent-model', thinking: 'xhigh', provider: 'openai' },
            },
            content: [
              'name = "reviewer-codex"',
              'developer_instructions = "Review this batch"',
            ].join('\n'),
          } : null,
      },
    });

    await expect(state.spawner.spawn('caller', {
      adapter: 'codex-cli',
      agentName: 'reviewer-codex',
      cwd: '.',
      prompt: 'Inspect',
    })).resolves.toMatchObject({ agentName: 'reviewer-codex' });
    expect(state.describe).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai' }));
    expect(state.createSpawnSession.mock.calls[0]![0].params.options).toMatchObject({
      model: 'agent-model',
      thinking: 'xhigh',
      provider: 'openai',
    });
  });
});
