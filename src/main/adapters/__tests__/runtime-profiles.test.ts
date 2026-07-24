import { describe, expect, it } from 'vitest';

import type { SessionAdapterId } from '@shared/types';
import { getAdapterRuntimeProfile, isSessionAdapterId } from '../runtime-profiles';

describe('adapter runtime profiles', () => {
  it.each<SessionAdapterId>([
    'claude-code',
    'deepseek-claude-code',
    'codex-cli',
    'grok-build',
  ])('resolves %s', (adapterId) => {
    expect(getAdapterRuntimeProfile(adapterId).id).toBe(adapterId);
  });

  it('keeps provider-specific prompt and capability declarations', () => {
    expect(getAdapterRuntimeProfile('claude-code').prompt.injection).toBe(
      'claude-system-prompt-append',
    );
    expect(getAdapterRuntimeProfile('codex-cli').prompt.injection).toBe(
      'codex-developer-instructions',
    );
    expect(getAdapterRuntimeProfile('grok-build')).toMatchObject({
      prompt: { injection: 'grok-acp-agent-profile' },
      capabilities: {
        canForkSession: false,
        canRespondPermission: true,
        canSetPermissionMode: false,
        canSetSessionMode: true,
        canAcceptAttachments: false,
      },
      runtimeControls: {
        permissionModes: [],
        sessionModes: ['default', 'plan', 'ask'],
      },
    });
  });

  it('guards adapter ids at runtime', () => {
    expect(isSessionAdapterId('grok-build')).toBe(true);
    expect(isSessionAdapterId('terminal-scraper')).toBe(false);
  });
});
