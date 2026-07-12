/**
 * Per-session Codex app-server client lifecycle.
 *
 * The bridge keeps the map itself as a stable test/integration seam; this module owns the
 * environment/config construction and the path-change, quota-read, and rename operations.
 */
import { settingsStore } from '@main/store/settings-store';
import {
  AGENT_DECK_MCP_TOKEN_ENV,
  buildAgentDeckMcpConfigForCodex,
  mergeCodexConfig,
} from '@main/codex-config/agent-deck-mcp-injector';
import { getCodexSkillExtraRootsForSession } from '@main/codex-config/skills-installer';
import { invalidateCodexInstance } from '@main/adapters/codex-cli/codex-instance-pool';
import type { ProviderUsageSnapshot } from '@shared/types';
import {
  buildCodexUsageSnapshot,
  errorUsageSnapshot,
  type CodexAccountRateLimitsResponseLike,
} from '../../provider-usage';
import {
  codexUsageUnavailableSnapshot,
  invalidateCodexUsageSnapshotClient,
  isExpectedCodexUsageUnavailable,
  readCodexUsageSnapshotInBackground,
} from '../usage-snapshot';
import { CodexAppServerClient } from '../app-server/client';
import type { CodexBridgeOptions, InternalSession } from './types';
import log from '@main/utils/logger';

const logger = log.scope('codex-bridge');

function snapshotProcessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export interface EnsureCodexClientOptions {
  clients: Map<string, CodexAppServerClient>;
  sessionId: string;
  sessionToken: string;
  hookServer: CodexBridgeOptions['hookServer'];
  envOverrideExtra?: Readonly<Record<string, string>>;
}

/** Return the session client, constructing it with a frozen per-session environment on a miss. */
export function ensureCodexClient({
  clients,
  sessionId,
  sessionToken,
  hookServer,
  envOverrideExtra,
}: EnsureCodexClientOptions): CodexAppServerClient {
  const cached = clients.get(sessionId);
  if (cached) return cached;

  const codexCliPath = settingsStore.get('codexCliPath');
  const userCodexPath = codexCliPath && codexCliPath.trim();
  const settings = settingsStore.getAll();
  const agentDeckMcpConfig = buildAgentDeckMcpConfigForCodex(settings, hookServer ?? null);
  const codexConfig = mergeCodexConfig(null, agentDeckMcpConfig);
  if (agentDeckMcpConfig) {
    logger.info(
      `[codex-bridge] agent-deck MCP server configured as required ` +
        `(HTTP transport, sid=${sessionId})`,
    );
  }

  // Supplying env replaces SDK inheritance, so preserve the process snapshot before adding the
  // per-session MCP identity. Explicit caller overrides intentionally take precedence.
  const envOverride = snapshotProcessEnv();
  envOverride[AGENT_DECK_MCP_TOKEN_ENV] = sessionToken;
  if (envOverrideExtra) Object.assign(envOverride, envOverrideExtra);
  envOverride.AGENT_DECK_ORIGIN = 'sdk';

  const client = new CodexAppServerClient({
    codexPathOverride: userCodexPath || null,
    config: codexConfig,
    env: envOverride,
    skillExtraRoots: getCodexSkillExtraRootsForSession(),
  });
  clients.set(sessionId, client);
  return client;
}

/** Dispose only idle clients when the configured CLI path changes. */
export function invalidateCodexClientsForPathChange(
  clients: Map<string, CodexAppServerClient>,
  sessions: ReadonlyMap<string, InternalSession>,
): void {
  for (const [sessionId, client] of clients.entries()) {
    if (sessions.has(sessionId)) continue;
    try {
      client.dispose();
    } catch {
      // best-effort invalidation
    }
    clients.delete(sessionId);
  }
  invalidateCodexInstance();
  invalidateCodexUsageSnapshotClient();
}

export async function getCodexUsageSnapshot(
  clients: ReadonlyMap<string, CodexAppServerClient>,
): Promise<ProviderUsageSnapshot> {
  const client = [...clients.values()].reverse().find((candidate) => candidate.isProcessAlive);
  if (!client) return readCodexUsageSnapshotInBackground();
  try {
    const response = await client.request<CodexAccountRateLimitsResponseLike>(
      'account/rateLimits/read',
      undefined,
    );
    return buildCodexUsageSnapshot(response);
  } catch (err) {
    if (isExpectedCodexUsageUnavailable(err)) {
      logger.debug('[codex-bridge] usage snapshot unavailable:', err);
      return codexUsageUnavailableSnapshot();
    }
    logger.warn('[codex-bridge] usage snapshot failed:', err);
    return errorUsageSnapshot('codex-cli', 'Codex', err);
  }
}

/** Move a client key without overwriting an already-owned target key. */
export function renameCodexClient(
  clients: Map<string, CodexAppServerClient>,
  oldId: string,
  newId: string,
): void {
  const client = clients.get(oldId);
  if (client === undefined || clients.has(newId)) return;
  clients.delete(oldId);
  clients.set(newId, client);
}
