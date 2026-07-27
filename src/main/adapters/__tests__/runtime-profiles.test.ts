import { describe, expect, it } from 'vitest';

import type { SessionAdapterId } from '@shared/types';
import { getAdapterRuntimeProfile, isSessionAdapterId } from '../runtime-profiles';

describe('adapter runtime profiles', () => {
  const runtimeAdapterIds: SessionAdapterId[] = [
    'claude-code',
    'codex-cli',
    'grok-build',
  ];

  it.each(runtimeAdapterIds)('resolves %s', (adapterId) => {
    expect(getAdapterRuntimeProfile(adapterId).id).toBe(adapterId);
  });

  it('keeps provider-specific prompt and capability declarations', () => {
    expect(getAdapterRuntimeProfile('claude-code')).toMatchObject({
      prompt: { injection: 'claude-system-prompt-append' },
      capabilities: {
        canRespondPermission: true,
        canSetPermissionMode: true,
        canRestartWithPermissionMode: true,
        canRestartWithClaudeCodeSandbox: true,
        canRestartWithCodexSandbox: false,
      },
      runtimeControls: {
        permissionModes: [
          'default',
          'acceptEdits',
          'plan',
          'auto',
          'bypassPermissions',
        ],
        sessionModes: [],
        providerOverride: 'claude-gateway',
        sandbox: 'claude',
        extraAllowWrite: true,
      },
    });
    expect(getAdapterRuntimeProfile('codex-cli')).toMatchObject({
      prompt: { injection: 'codex-developer-instructions' },
      capabilities: {
        canRespondPermission: true,
        canSetPermissionMode: false,
        canSetSessionMode: false,
        canRestartWithPermissionMode: false,
        canRestartWithCodexSandbox: true,
        canRestartWithClaudeCodeSandbox: false,
      },
      runtimeControls: {
        permissionModes: [],
        sessionModes: [],
        providerOverride: 'codex-model-provider',
        sandbox: 'codex',
        extraAllowWrite: true,
      },
    });
    expect(getAdapterRuntimeProfile('grok-build')).toMatchObject({
      prompt: { injection: 'grok-acp-agent-profile' },
      capabilities: {
        canForkSession: false,
        canInstallHooks: true,
        canRespondPermission: true,
        canSetPermissionMode: false,
        canSetSessionMode: true,
        canSteerTurn: true,
        canAcceptAttachments: false,
      },
      runtimeControls: {
        permissionModes: [],
        sessionModes: ['default', 'plan', 'ask'],
        providerOverride: 'none',
        sandbox: 'provider-native',
        extraAllowWrite: false,
      },
      model: {
        thinkingLevels: ['low', 'medium', 'high', 'xhigh'],
      },
    });
    expect({
      claude: getAdapterRuntimeProfile('claude-code').mcpBrowserTools,
      codex: getAdapterRuntimeProfile('codex-cli').mcpBrowserTools,
      grok: getAdapterRuntimeProfile('grok-build').mcpBrowserTools,
    }).toEqual({ claude: true, codex: false, grok: true });
  });

  it('guards adapter ids at runtime', () => {
    expect(isSessionAdapterId('grok-build')).toBe(true);
    expect(isSessionAdapterId('terminal-scraper')).toBe(false);
  });
});
