import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedClientAccessContext, CoreMethod, JsonValue } from '@contracts/index';
import type { DaemonCoreRuntime, DaemonRequestInput } from '@hosts/daemon';
import type { AgentAdapter } from '@main/adapters/types';
import { DEFAULT_SETTINGS } from '@shared/types';

import { ServerCoreNodeConfigurationRuntime } from './node-configuration-runtime';
import type { ServerCoreMutationIdentity } from './runtime-metadata-store';
import { resolveServerCoreProviderSettings } from './provider-settings';

const access: AuthenticatedClientAccessContext = {
  kind: 'authenticated-client',
  topology: 'server-core',
  instanceId: 'instance-a',
  clientId: 'desktop-a',
  transport: 'ssh',
  accessCredentialId: 'credential-a',
  authority: 'owner-equivalent',
  surface: 'desktop-full',
};

function base(): DaemonCoreRuntime {
  return {
    supportedMethods: ['system.health'],
    start: async () => undefined,
    stop: async () => undefined,
    currentRevision: () => 3,
    execute: async () => ({ result: { ok: true, revision: 3 }, revision: 3 }),
  };
}

function request(
  method: CoreMethod,
  params: Record<string, JsonValue>,
  idempotencyKey: string | null = null,
): DaemonRequestInput {
  return {
    access,
    requestId: `request:${method}`,
    method,
    params,
    idempotencyKey,
    expectedRevision: null,
    deadlineAt: null,
    signal: new AbortController().signal,
  };
}

describe('ServerCoreNodeConfigurationRuntime', () => {
  it('returns the immutable provider settings owned by the Worker Core', async () => {
    const runtime = new ServerCoreNodeConfigurationRuntime(base(), {
      settings: resolveServerCoreProviderSettings({ providerSettings: {
        claudeCodeSandbox: 'strict',
        codexSandbox: 'read-only',
        enableAgentDeckMcp: false,
        grokSandbox: 'off',
      } }),
      registry: { get: () => undefined },
      metadata: {
        currentRevision: () => 12,
        appendChange: vi.fn(),
        claimMutation: vi.fn(),
        completeMutation: vi.fn(),
        releaseMutationClaim: vi.fn(),
      },
    });
    const result = await runtime.execute(request('node.configuration.get', {}));
    expect(result).toMatchObject({
      revision: 12,
      result: {
        providerDefaults: {
          claudeCodeSandbox: 'strict',
          codexSandbox: 'read-only',
          enableAgentDeckMcp: false,
          grokSandbox: 'off',
          permissionTimeoutMs: DEFAULT_SETTINGS.permissionTimeoutMs,
        },
      },
    });
  });

  it('runs Hook mutations against the Worker adapter and replays completion', async () => {
    const install = vi.fn(async () => ({
      installed: true,
      installedHooks: ['SessionStart'],
      scope: 'user' as const,
      settingsPath: '/provider-home/.claude/settings.json',
    }));
    const adapter = {
      capabilities: { canInstallHooks: true },
      installIntegration: install,
    } as unknown as AgentAdapter;
    let completed: { identity: ServerCoreMutationIdentity; result: JsonValue; revision: number } | null = null;
    const runtime = new ServerCoreNodeConfigurationRuntime(base(), {
      settings: resolveServerCoreProviderSettings({}),
      registry: { get: () => adapter },
      metadata: {
        currentRevision: () => 1,
        appendChange: () => 2,
        claimMutation: (_identity) => completed
          ? { state: 'completed', result: completed.result, revision: completed.revision }
          : { state: 'claimed' },
        completeMutation: (identity, result, revision) => { completed = { identity, result, revision }; },
        releaseMutationClaim: vi.fn(),
      },
    });
    const input = request(
      'node.hook.install',
      { adapterId: 'claude-code' },
      'stable-hook-intent',
    );
    const first = await runtime.execute(input);
    const replay = await runtime.execute(input);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({ result: { status: { installed: true } }, revision: 2 });
    expect(install).toHaveBeenCalledOnce();
  });
});
