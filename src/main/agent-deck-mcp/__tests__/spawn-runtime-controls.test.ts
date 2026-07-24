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
      grokCapabilities,
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
      grokCapabilities,
    )).toMatchObject({
      error: expect.stringContaining('sandbox controls'),
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
});
