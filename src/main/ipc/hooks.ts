/**
 * Hook install / uninstall / status IPC handlers.
 *
 * Backward compatibility: older renderer calls omit adapterId and still target Claude Code.
 */
import { IpcInvoke } from '@shared/ipc-channels';
import { adapterRegistry } from '@main/adapters/registry';
import { IpcInputError, on, parseHookScope, parseHookCwd } from './_helpers';

type HookAdapterId = 'claude-code' | 'codex-cli' | 'grok-build';

function parseHookAdapter(value: unknown): HookAdapterId {
  if (value === undefined || value === null) return 'claude-code';
  if (value === 'claude-code' || value === 'codex-cli' || value === 'grok-build') {
    return value;
  }
  throw new IpcInputError(
    'adapterId',
    `must be 'claude-code', 'codex-cli', or 'grok-build', got ${String(value)}`,
  );
}

function getHookAdapter(value: unknown) {
  const adapterId = parseHookAdapter(value);
  const adapter = adapterRegistry.get(adapterId);
  if (!adapter?.capabilities.canInstallHooks) {
    throw new Error(`${adapterId} hook integration not available`);
  }
  return adapter;
}

export function registerHooksIpc(): void {
  on(IpcInvoke.HookInstall, async (_e, scope, cwd, adapterId) => {
    const adapter = getHookAdapter(adapterId);
    if (!adapter.installIntegration) throw new Error('adapter installIntegration unavailable');
    const parsedScope = parseHookScope(scope);
    return adapter.installIntegration({
      scope: parsedScope,
      cwd: parseHookCwd(parsedScope, cwd),
    });
  });
  on(IpcInvoke.HookUninstall, async (_e, scope, cwd, adapterId) => {
    const adapter = getHookAdapter(adapterId);
    if (!adapter.uninstallIntegration) throw new Error('adapter uninstallIntegration unavailable');
    const parsedScope = parseHookScope(scope);
    return adapter.uninstallIntegration({
      scope: parsedScope,
      cwd: parseHookCwd(parsedScope, cwd),
    });
  });
  on(IpcInvoke.HookStatus, async (_e, scope, cwd, adapterId) => {
    const adapter = getHookAdapter(adapterId);
    if (!adapter.integrationStatus) throw new Error('adapter integrationStatus unavailable');
    const parsedScope = parseHookScope(scope);
    return adapter.integrationStatus({
      scope: parsedScope,
      cwd: parseHookCwd(parsedScope, cwd),
    });
  });
}
