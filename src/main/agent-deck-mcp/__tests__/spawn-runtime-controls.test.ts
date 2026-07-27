import { describe, expect, it } from 'vitest';

import { getAdapterRuntimeProfile } from '@main/adapters/runtime-profiles';
import type { SessionRecord } from '@shared/types';
import {
  resolveSpawnRuntimeControls,
  validateSpawnRuntimeControls,
} from '../tools/handlers/spawn-runtime-controls';

describe('spawn adapter runtime controls', () => {
  const grokCapabilities = getAdapterRuntimeProfile('grok-build').capabilities;

  it('rejects Claude permission controls for Grok with an actionable hint', () => {
    expect(validateSpawnRuntimeControls(
      {
        adapter: 'grok-build',
        cwd: '/repo',
        prompt: 'work',
        permissionMode: 'plan',
      },
    )).toMatchObject({
      error: expect.stringContaining('permissionMode'),
      hint: expect.stringContaining('Grok ACP work modes'),
    });
  });

  it('rejects foreign sandbox controls for Grok', () => {
    expect(validateSpawnRuntimeControls(
      {
        adapter: 'grok-build',
        cwd: '/repo',
        prompt: 'work',
        codexSandbox: 'workspace-write',
      },
    )).toMatchObject({
      error: expect.stringContaining('codexSandbox'),
    });
  });

  it('rejects cross-wired Claude and Codex sandbox fields instead of filtering them', () => {
    expect(validateSpawnRuntimeControls({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'work',
      codexSandbox: 'read-only',
    })).toMatchObject({
      error: expect.stringContaining('codexSandbox'),
    });
    expect(validateSpawnRuntimeControls({
      adapter: 'codex-cli',
      cwd: '/repo',
      prompt: 'work',
      claudeCodeSandbox: 'strict',
    })).toMatchObject({
      error: expect.stringContaining('claudeCodeSandbox'),
    });
  });

  it('rejects a Grok provider override at the runtime-control boundary', () => {
    expect(validateSpawnRuntimeControls({
      adapter: 'grok-build',
      cwd: '/repo',
      prompt: 'work',
      provider: 'xai',
    })).toMatchObject({
      error: expect.stringContaining('provider'),
    });
  });

  it('inherits only the Grok-native mode for a same-adapter spawn', () => {
    const resolved = resolveSpawnRuntimeControls({
      args: { adapter: 'grok-build', cwd: '/repo', prompt: 'work' },
      capabilities: grokCapabilities,
      leadRecord: {
        agentId: 'grok-build',
        sessionMode: 'ask',
        permissionMode: 'bypassPermissions',
      } as SessionRecord,
      inherit: true,
      codexSandboxFromAgent: undefined,
    });
    expect(resolved.effectiveSessionMode).toBe('ask');
    expect(resolved.effectivePermissionMode).toBeUndefined();
  });

  it('does not expose a provider-restored dontAsk state to a new spawned session', () => {
    const claudeCapabilities =
      getAdapterRuntimeProfile('claude-code').capabilities;
    const resolved = resolveSpawnRuntimeControls({
      args: { adapter: 'claude-code', cwd: '/repo', prompt: 'work' },
      capabilities: claudeCapabilities,
      leadRecord: {
        agentId: 'claude-code',
        permissionMode: 'dontAsk',
      } as SessionRecord,
      inherit: true,
      codexSandboxFromAgent: undefined,
    });
    expect(resolved.effectivePermissionMode).toBe('default');
  });
});
