import {
  AGENT_DECK_MCP_TOKEN_ENV,
  buildAgentDeckMcpConfigForCodex,
  mergeCodexConfig,
} from '@main/codex-config/agent-deck-mcp-injector';
import type { CodexAppServerOptions } from '../app-server/protocol';
import type { CodexAppServerClient } from '../app-server/client';
import type { AppSettings } from '@shared/types';
import type { CodexBridgeOptions } from './types';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';

export interface CodexClientConstructionHost {
  createClient(options: CodexAppServerOptions): CodexAppServerClient;
  readCodexCliPath(): string | null;
  readSettings(): AppSettings;
  readSkillExtraRoots(): string[];
  snapshotProcessEnv(): Record<string, string>;
  prepareBrowserRuntime?(
    sessionId: string,
    environment: Readonly<Record<string, string>>,
  ): { environment: Record<string, string> } | null;
  browserSocketConfig?(environment: Readonly<Record<string, string>>): CodexConfigObject | null;
  revokeBrowserRuntime?(sessionId: string): void;
}

export interface EnsureCodexClientOptions {
  clients: Map<string, CodexAppServerClient>;
  sessionId: string;
  sessionToken: string;
  hookServer: CodexBridgeOptions['hookServer'];
}

/** Construct and register one per-session client without discovering desktop process state. */
export function ensureCodexClientWithHost(
  options: EnsureCodexClientOptions,
  host: CodexClientConstructionHost,
): CodexAppServerClient {
  const cached = options.clients.get(options.sessionId);
  if (cached) return cached;

  const configuredPath = host.readCodexCliPath();
  const codexPathOverride = configuredPath?.trim() || null;
  const settings = host.readSettings();
  const agentDeckMcpConfig = buildAgentDeckMcpConfigForCodex(
    settings,
    options.hookServer ?? null,
  );
  const env = host.snapshotProcessEnv();
  env[AGENT_DECK_MCP_TOKEN_ENV] = options.sessionToken;
  env.AGENT_DECK_ORIGIN = 'sdk';
  const browserRuntime = host.prepareBrowserRuntime?.(options.sessionId, env) ?? null;
  const browserConfig = browserRuntime == null
    ? null
    : host.browserSocketConfig?.(browserRuntime.environment) ?? null;
  let client: CodexAppServerClient;
  try {
    client = host.createClient({
      codexPathOverride,
      config: mergeCodexConfig(
        mergeCodexConfig(null, agentDeckMcpConfig),
        browserConfig,
      ),
      env: browserRuntime?.environment ?? env,
      skillExtraRoots: host.readSkillExtraRoots(),
      nodeReplBrowserBootstrap: true,
    });
  } catch (error) {
    host.revokeBrowserRuntime?.(options.sessionId);
    throw error;
  }
  options.clients.set(options.sessionId, client);
  return client;
}
