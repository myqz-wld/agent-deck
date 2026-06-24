import type { SpawnSessionArgs } from '../schemas';

export function defaultPermissionModeForTargetAdapter(
  adapter: SpawnSessionArgs['adapter'],
): 'bypassPermissions' | undefined {
  if (adapter === 'claude-code' || adapter === 'deepseek-claude-code') {
    return 'bypassPermissions';
  }
  return undefined;
}
