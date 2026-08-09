import { setSessionCloseFn, setSessionRenameHookFn } from '@main/session/manager';
import log from '@main/utils/logger';

import { desktopClaudeCodeAdapterHost } from './claude-code/adapter-init-host';
import { desktopCodexCliAdapterHost } from './codex-cli/adapter-init-host';
import { desktopGrokBuildAdapterHost } from './grok-build/adapter-host';
import { adapterRegistry } from './registry';
import type { AgentAdapter } from './types';
import type { ProviderRuntimeCompositionHost } from './provider-runtime-core';
import { createProviderAdapterSet } from './provider-adapter-set-core';

const logger = log.scope('bootstrap-infra');
const desktopProviderAdapters = createProviderAdapterSet({
  claude: desktopClaudeCodeAdapterHost,
  codex: desktopCodexCliAdapterHost,
  grok: desktopGrokBuildAdapterHost,
});

function renameCodexLiveSession(
  agentId: string,
  adapter: AgentAdapter | undefined,
  fromId: string,
  toId: string,
): void {
  if (agentId !== 'codex-cli') return;
  const bridge = (adapter as {
    bridge?: { renameCodexInstance?: (from: string, to: string) => void };
  } | undefined)?.bridge;
  bridge?.renameCodexInstance?.(fromId, toId);
}

/** Desktop ownership for the otherwise host-neutral provider runtime composition. */
export const desktopProviderRuntimeCompositionHost: ProviderRuntimeCompositionHost = {
  registry: adapterRegistry,
  adapters: desktopProviderAdapters.adapters,
  installSessionClose: (handler) => setSessionCloseFn(handler),
  installSessionRename: (handler) => setSessionRenameHookFn(handler),
  renameLiveSession: renameCodexLiveSession,
  reportAdapterInitFailure: (result) => {
    logger.error(
      `[adapter] ${result.id} init FAILED — ` +
        '该 adapter 的会话将无法创建(spawn / resume 时 createSession 会抛 ' +
        '"adapter not initialized")。其他 adapter 不受影响仍可用。',
      result.err,
    );
  },
};
