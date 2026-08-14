import { describe, expect, it, vi } from 'vitest';

import {
  issueRemoteOwnerGrantClaim,
  type AuthenticatedClientAccessContext,
  type CoreMethod,
  type JsonValue,
  type NodeConfigurationAdapterId,
  type NodeHookProjectionState,
} from '@contracts/index';
import type { DaemonCoreRuntime, DaemonRequestInput } from '@hosts/daemon';
import type { AgentAdapter } from '@main/adapters/types';
import { DEFAULT_SETTINGS } from '@shared/types';

import { ServerCoreNodeConfigurationRuntime } from './node-configuration-runtime';
import { resolveServerCoreProviderSettings } from './provider-settings';
import { resolveServerCoreSessionLifecycleSettings } from './session-lifecycle-options';

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

function hookStates(initial: Partial<Record<NodeConfigurationAdapterId, NodeHookProjectionState>> = {}) {
  const states = new Map(Object.entries(initial) as Array<[
    NodeConfigurationAdapterId,
    NodeHookProjectionState,
  ]>);
  return {
    get: (adapterId: NodeConfigurationAdapterId) => states.get(adapterId) ?? null,
    set: (adapterId: NodeConfigurationAdapterId, state: NodeHookProjectionState) => {
      states.set(adapterId, state);
    },
  };
}

describe('ServerCoreNodeConfigurationRuntime', () => {
  it('returns the immutable provider settings owned by the Worker Core', async () => {
    const runtime = new ServerCoreNodeConfigurationRuntime(base(), {
      settings: resolveServerCoreProviderSettings({ providerSettings: {
        claudeCliPath: '/opt/claude',
        claudeCodeSandbox: 'strict',
        codexCliPath: '/opt/codex',
        codexSandbox: 'read-only',
        enableAgentDeckMcp: false,
        grokCliPath: '/opt/grok',
        grokSandbox: 'off',
        injectAgentDeckClaudeAgents: false,
        mcpHttpEnabled: false,
      } }),
      sessionLifecycle: resolveServerCoreSessionLifecycleSettings({
        sessionLifecycle: {
          schemaVersion: 1,
          activeWindowMs: 120_000,
          closeAfterMs: 3_600_000,
          historyRetentionDays: 14,
          issueResolvedRetentionDays: 21,
          issueSoftDeletedRetentionDays: 5,
          messageRetentionDays: 28,
        },
      }),
      hookStates: hookStates(),
      registry: { get: () => undefined, isReady: () => false },
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
          claudeCliPath: '/opt/claude',
          claudeCodeSandbox: 'strict',
          codexCliPath: '/opt/codex',
          codexSandbox: 'read-only',
          enableAgentDeckMcp: false,
          grokCliPath: '/opt/grok',
          grokSandbox: 'off',
          injectAgentDeckClaudeAgents: false,
          mcpHttpEnabled: false,
          permissionTimeoutMs: DEFAULT_SETTINGS.permissionTimeoutMs,
        },
        sessionLifecycle: {
          activeWindowMs: 120_000,
          closeAfterMs: 3_600_000,
          historyRetentionDays: 14,
          issueResolvedRetentionDays: 21,
          issueSoftDeletedRetentionDays: 5,
          messageRetentionDays: 28,
        },
      },
    });
  });

  it('never advertises Hook mutation even when the Worker adapter can install Hooks', async () => {
    const install = vi.fn(async () => ({
      installed: true,
      installedHooks: ['SessionStart'],
      scope: 'user' as const,
      settingsPath: '/provider-home/.claude/settings.json',
    }));
    const adapter = {
      capabilities: { canInstallHooks: true },
      installIntegration: install,
      uninstallIntegration: vi.fn(async () => ({
        installed: false,
        installedHooks: [],
        scope: 'user' as const,
        settingsPath: '/provider-home/.claude/settings.json',
      })),
      integrationStatus: vi.fn(async () => ({
        installed: false,
        installedHooks: [],
        scope: 'user' as const,
        settingsPath: '/provider-home/.claude/settings.json',
      })),
    } as unknown as AgentAdapter;
    const runtime = new ServerCoreNodeConfigurationRuntime(base(), {
      settings: resolveServerCoreProviderSettings({}),
      sessionLifecycle: resolveServerCoreSessionLifecycleSettings({}),
      hookStates: hookStates({ 'claude-code': 'installed' }),
      registry: { get: () => adapter, isReady: () => true },
      metadata: {
        currentRevision: () => 1,
        appendChange: vi.fn(),
        claimMutation: vi.fn(),
        completeMutation: vi.fn(),
        releaseMutationClaim: vi.fn(),
      },
    });
    expect(runtime.supportedMethods).not.toContain('node.hook.projection.install');
    expect(runtime.supportedMethods).not.toContain('node.hook.projection.uninstall');
    await expect(runtime.execute(request(
      'node.hook.projection.get',
      { adapterId: 'claude-code' },
    ))).resolves.toMatchObject({
      result: {
        status: {
          state: 'installed',
          supported: true,
          writeAllowed: false,
          disabledReason: 'mutation-unavailable',
        },
      },
      revision: 1,
    });
    expect(install).not.toHaveBeenCalled();
  });

  it('reads only the Worker-owned safe Hook snapshot', async () => {
    const integrationStatus = vi.fn(async () => ({
      installed: true,
      installedHooks: ['must-not-be-read'],
      scope: 'user' as const,
      settingsPath: '/provider-home/.claude/settings.json',
    }));
    const adapter = {
      capabilities: { canInstallHooks: true },
      installIntegration: vi.fn(),
      uninstallIntegration: vi.fn(),
      integrationStatus,
    } as unknown as AgentAdapter;
    const runtime = new ServerCoreNodeConfigurationRuntime(base(), {
      settings: resolveServerCoreProviderSettings({}),
      sessionLifecycle: resolveServerCoreSessionLifecycleSettings({}),
      hookStates: hookStates({ 'claude-code': 'installed' }),
      registry: { get: () => adapter, isReady: () => true },
      metadata: {
        currentRevision: () => 5,
        appendChange: vi.fn(),
        claimMutation: vi.fn(),
        completeMutation: vi.fn(),
        releaseMutationClaim: vi.fn(),
      },
    });
    await expect(runtime.execute(request(
      'node.hook.projection.get',
      { adapterId: 'claude-code' },
    ))).resolves.toMatchObject({ result: { status: { state: 'installed' } } });
    expect(integrationStatus).not.toHaveBeenCalled();
  });

  it('returns an explicit path-free unavailable status for an unsupported adapter', async () => {
    const runtime = new ServerCoreNodeConfigurationRuntime(base(), {
      settings: resolveServerCoreProviderSettings({}),
      sessionLifecycle: resolveServerCoreSessionLifecycleSettings({}),
      hookStates: hookStates(),
      registry: { get: () => undefined, isReady: () => false },
      metadata: {
        currentRevision: () => 4,
        appendChange: vi.fn(),
        claimMutation: vi.fn(),
        completeMutation: vi.fn(),
        releaseMutationClaim: vi.fn(),
      },
    });
    await expect(runtime.execute(request(
      'node.hook.projection.get',
      { adapterId: 'grok-build' },
    ))).resolves.toMatchObject({
      result: {
        adapterId: 'grok-build',
        status: {
          supported: false,
          state: 'unavailable',
          scope: null,
          writeAllowed: false,
          disabledReason: 'adapter-unavailable',
        },
      },
    });
  });

  it('keeps a registered adapter unavailable until initialization succeeds', async () => {
    const installIntegration = vi.fn();
    const adapter = {
      capabilities: { canInstallHooks: true },
      installIntegration,
      uninstallIntegration: vi.fn(),
    } as unknown as AgentAdapter;
    const runtime = new ServerCoreNodeConfigurationRuntime(base(), {
      settings: resolveServerCoreProviderSettings({}),
      sessionLifecycle: resolveServerCoreSessionLifecycleSettings({}),
      hookStates: hookStates({ 'claude-code': 'installed' }),
      registry: { get: () => adapter, isReady: () => false },
      metadata: {
        currentRevision: () => 4,
        appendChange: vi.fn(),
        claimMutation: vi.fn(() => ({ state: 'claimed' as const })),
        completeMutation: vi.fn(),
        releaseMutationClaim: vi.fn(),
      },
    });

    await expect(runtime.execute(request(
      'node.hook.projection.get',
      { adapterId: 'claude-code' },
    ))).resolves.toMatchObject({
      result: { status: { supported: false, state: 'unavailable', writeAllowed: false } },
    });
    expect(runtime.supportedMethods).not.toContain('node.hook.projection.install');
    expect(installIntegration).not.toHaveBeenCalled();
  });
});
