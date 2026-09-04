import { join } from 'node:path';

import type { RuntimeAdapterId } from '@shared/types';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import { getApplicationHostPaths } from '@main/runtime-host/application-paths';
import { getApplicationResourcesRoot } from '@main/runtime-host/application-resources';
import { settingsStore } from '@main/store/settings-store';
import log from '@main/utils/logger';

import { getBrowserLeaseRegistry } from './browser-lease-registry';
import {
  BROWSER_RUNTIME_BIN_ENV,
  BROWSER_RUNTIME_KEY_ENV,
  BrowserRuntimeContextManager,
  type PreparedBrowserRuntimeContext,
} from './browser-runtime-context';
import { setBrowserRuntimeLifecyclePort } from './browser-runtime-lifecycle';

let manager: BrowserRuntimeContextManager | null = null;
let brokerEndpoint: string | null = null;
const logger = log.scope('browser-runtime');

export function initializeBrowserRuntimeContextHost(endpoint: string): void {
  manager?.shutdown();
  brokerEndpoint = endpoint;
  const runtimeRoot = process.platform === 'win32'
    ? join(getApplicationHostPaths().userDataPath, 'browser-runtimes')
    : join('/tmp', `agent-deck-browser-runtimes-${process.getuid?.() ?? process.pid}`);
  manager = new BrowserRuntimeContextManager({
    rootDir: runtimeRoot,
    brokerEndpoint: endpoint,
    executablePath: process.execPath,
    cliPath: join(getApplicationResourcesRoot(), 'bin', 'agent-deck-browser.cjs'),
    registry: getBrowserLeaseRegistry(),
  });
  setBrowserRuntimeLifecyclePort({
    renameSession: (fromId, toId) => manager?.renameSession(fromId, toId) ?? 0,
    revokeSession: (sessionId) => manager?.revokeSession(sessionId) ?? 0,
  });
}

export function setBrowserRuntimeContextManagerForTests(
  value: BrowserRuntimeContextManager | null,
  endpoint: string | null = null,
): void {
  manager = value;
  brokerEndpoint = endpoint;
  setBrowserRuntimeLifecyclePort(value == null ? null : {
    renameSession: (fromId, toId) => value.renameSession(fromId, toId),
    revokeSession: (sessionId) => value.revokeSession(sessionId),
  });
}

export function browserSkillEnabled(adapterId: RuntimeAdapterId): boolean {
  switch (adapterId) {
    case 'claude-code':
      return settingsStore.get('injectAgentDeckClaudeSkills') !== false;
    case 'codex-cli':
      return settingsStore.get('injectAgentDeckCodexSkills') === true;
    case 'grok-build':
      return settingsStore.get('injectAgentDeckGrokSkills') === true;
  }
}

export function prepareBrowserRuntimeEnvironment(input: {
  readonly applicationSessionId: string;
  readonly adapterId: RuntimeAdapterId;
  readonly environment: Readonly<Record<string, string>>;
}): PreparedBrowserRuntimeContext | null {
  if (!browserSkillEnabled(input.adapterId) || manager == null) return null;
  return manager.prepare(input);
}

/** Rotate the lease/context immediately before a provider process generation starts. */
export function refreshBrowserRuntimeFromEnvironment(
  environment: Readonly<Record<string, string>>,
): PreparedBrowserRuntimeContext | null {
  const runtimeKey = environment[BROWSER_RUNTIME_KEY_ENV];
  if (runtimeKey == null || manager == null) return null;
  return manager.refresh(runtimeKey);
}

/** Best-effort turn-boundary renewal; provider work remains usable if Browser repair fails. */
export function refreshBrowserRuntimeSession(applicationSessionId: string): boolean {
  if (manager == null) return false;
  try {
    return manager.refreshSession(applicationSessionId) != null;
  } catch (error) {
    logger.warn('[browser-runtime] failed to refresh session context', error);
    return false;
  }
}

export function renameBrowserRuntimeSession(fromId: string, toId: string): number {
  return manager?.renameSession(fromId, toId) ?? 0;
}

export function revokeBrowserRuntimeSession(applicationSessionId: string): number {
  return manager?.revokeSession(applicationSessionId) ?? 0;
}

export function shutdownBrowserRuntimeContexts(): number {
  const count = manager?.shutdown() ?? 0;
  manager = null;
  brokerEndpoint = null;
  setBrowserRuntimeLifecyclePort(null);
  return count;
}

/** Exact Codex network-proxy socket allowlist; never enables arbitrary Unix sockets. */
export function codexBrowserSocketConfig(
  environment: Readonly<Record<string, string>>,
): CodexConfigObject | null {
  if (brokerEndpoint == null) return null;
  const pathValue = environment.PATH ?? environment.Path;
  const runtimeKey = environment[BROWSER_RUNTIME_KEY_ENV];
  const binDir = environment[BROWSER_RUNTIME_BIN_ENV];
  const explicitEnvironment: CodexConfigObject = {};
  if (pathValue) explicitEnvironment.PATH = pathValue;
  if (runtimeKey) explicitEnvironment[BROWSER_RUNTIME_KEY_ENV] = runtimeKey;
  if (binDir) explicitEnvironment[BROWSER_RUNTIME_BIN_ENV] = binDir;
  return {
    shell_environment_policy: {
      set: explicitEnvironment,
    },
    ...(process.platform === 'win32'
      ? {}
      : {
          features: {
            network_proxy: {
              enabled: true,
              unix_sockets: {
                [brokerEndpoint]: 'allow',
              },
            },
          },
        }),
  };
}

export function allowClaudeBrowserSocket<T extends {
  sandbox?: {
    network?: { allowUnixSockets?: string[]; [key: string]: unknown };
    [key: string]: unknown;
  };
}>(sandboxOptions: T): T {
  if (brokerEndpoint == null || process.platform === 'win32' || sandboxOptions.sandbox == null) {
    return sandboxOptions;
  }
  const existing = sandboxOptions.sandbox.network?.allowUnixSockets ?? [];
  return {
    ...sandboxOptions,
    sandbox: {
      ...sandboxOptions.sandbox,
      network: {
        ...sandboxOptions.sandbox.network,
        allowUnixSockets: [...new Set([...existing, brokerEndpoint])],
      },
    },
  };
}
