import { describe, expect, it, vi } from 'vitest';
import { SDK_RESTART_RESUME_PROMPT } from '@shared/restart-prompts';
import { applyServerCoreRuntimePatch } from './runtime-controls';

describe('Core permission transition effects', () => {
  it('uses a cold restart for Claude bypass and reports the replacement identity', async () => {
    const restartWithPermissionMode = vi.fn().mockResolvedValue('replacement-session');
    const setPermissionMode = vi.fn();
    const result = await applyServerCoreRuntimePatch({ restartWithPermissionMode, setPermissionMode } as never,
      { id: 'session-a', agentId: 'claude-code' } as never, { permissionMode: 'bypassPermissions' });
    expect(restartWithPermissionMode).toHaveBeenCalledWith('session-a', 'bypassPermissions', SDK_RESTART_RESUME_PROMPT);
    expect(setPermissionMode).not.toHaveBeenCalled();
    expect(result).toEqual({ effect: 'restart-required', replacementSessionId: 'replacement-session' });
  });

  it('does not silently hot-apply Claude bypass when cold restart is unavailable', async () => {
    const setPermissionMode = vi.fn();
    await expect(applyServerCoreRuntimePatch({ setPermissionMode } as never,
      { id: 'session-a', agentId: 'claude-code' } as never, { permissionMode: 'bypassPermissions' }))
      .rejects.toThrow('Runtime control is not available');
    expect(setPermissionMode).not.toHaveBeenCalled();
  });

  it.each([
    ['claude-code', 'auto'], ['codex-cli', 'auto'], ['codex-cli', 'bypassPermissions'],
    ['grok-build', 'auto'], ['grok-build', 'bypassPermissions'],
  ])('applies %s %s without restarting a provider', async (agentId, permissionMode) => {
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const restartWithPermissionMode = vi.fn();
    const result = await applyServerCoreRuntimePatch({ setPermissionMode, restartWithPermissionMode } as never,
      { id: 'session-a', agentId } as never, { permissionMode });
    expect(setPermissionMode).toHaveBeenCalledWith('session-a', permissionMode);
    expect(restartWithPermissionMode).not.toHaveBeenCalled();
    expect(result).toEqual({ effect: 'hot-applied', replacementSessionId: null });
  });
});
