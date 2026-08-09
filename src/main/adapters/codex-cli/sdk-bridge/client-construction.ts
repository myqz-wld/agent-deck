import {
  AGENT_DECK_MCP_TOKEN_ENV,
  buildAgentDeckMcpConfigForCodex,
  mergeCodexConfig,
} from '@main/codex-config/agent-deck-mcp-injector';
import type { CodexAppServerOptions } from '../app-server/protocol';
import type { CodexAppServerClient } from '../app-server/client';
import type { AppSettings } from '@shared/types';
import type { CodexBridgeOptions } from './types';

export interface CodexClientConstructionHost {
  createClient(options: CodexAppServerOptions): CodexAppServerClient;
  readCodexCliPath(): string | null;
  readSettings(): AppSettings;
  readSkillExtraRoots(): string[];
  snapshotProcessEnv(): Record<string, string>;
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
  const client = host.createClient({
    codexPathOverride,
    config: mergeCodexConfig(null, agentDeckMcpConfig),
    env,
    skillExtraRoots: host.readSkillExtraRoots(),
    nodeReplBrowserBootstrap: true,
  });
  options.clients.set(options.sessionId, client);
  return client;
}
