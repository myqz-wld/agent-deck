/**
 * Hook 安装 / 卸载 / 状态查询 IPC handler（claude-code adapter）。
 */
import { IpcInvoke } from '@shared/ipc-channels';
import { adapterRegistry } from '@main/adapters/registry';
import { on, parseHookScope, parseHookCwd } from './_helpers';

export function registerHooksIpc(): void {
  on(IpcInvoke.HookInstall, async (_e, scope, cwd) => {
    const adapter = adapterRegistry.get('claude-code');
    if (!adapter?.installIntegration) throw new Error('adapter not available');
    const parsedScope = parseHookScope(scope);
    return adapter.installIntegration({
      scope: parsedScope,
      cwd: parseHookCwd(parsedScope, cwd),
    });
  });
  on(IpcInvoke.HookUninstall, async (_e, scope, cwd) => {
    const adapter = adapterRegistry.get('claude-code');
    if (!adapter?.uninstallIntegration) throw new Error('adapter not available');
    const parsedScope = parseHookScope(scope);
    return adapter.uninstallIntegration({
      scope: parsedScope,
      cwd: parseHookCwd(parsedScope, cwd),
    });
  });
  on(IpcInvoke.HookStatus, async (_e, scope, cwd) => {
    const adapter = adapterRegistry.get('claude-code');
    if (!adapter?.integrationStatus) throw new Error('adapter not available');
    const parsedScope = parseHookScope(scope);
    return adapter.integrationStatus({
      scope: parsedScope,
      cwd: parseHookCwd(parsedScope, cwd),
    });
  });
}
