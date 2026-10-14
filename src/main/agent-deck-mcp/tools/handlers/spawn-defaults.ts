import type { SpawnSessionArgs } from '../schemas';

export function defaultPermissionModeForTargetAdapter(
  adapter: SpawnSessionArgs['adapter'],
): 'auto' | 'bypassPermissions' | undefined {
  if (adapter === 'claude-code') {
    return 'bypassPermissions';
  }
  if (adapter === 'grok-build') return 'auto';
  return undefined;
}
