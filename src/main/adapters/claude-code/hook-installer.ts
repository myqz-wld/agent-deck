import { HookInstallerCore } from './hook-installer-core';
import { desktopClaudeHookInstallerObserver } from './hook-installer-host';

export { CLAUDE_HOOK_EVENTS } from './hook-installer-core';

export class HookInstaller extends HookInstallerCore {
  constructor(port: number, token: string, relayRoot: string) {
    super(port, token, relayRoot, desktopClaudeHookInstallerObserver);
  }
}
