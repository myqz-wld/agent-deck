/**
 * Per-session Codex app-server client lifecycle.
 *
 * The bridge keeps the map itself as a stable test/integration seam; this module owns the
 * environment/config construction and the path-change, quota-read, and rename operations.
 */
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
import type { CodexAppServerClient } from '../app-server/client';
import type { InternalSession } from './types';
import {
  ensureCodexClientWithHost,
  type EnsureCodexClientOptions,
} from './client-construction';
import { desktopCodexClientConstructionHost } from './client-construction-host';

export type { EnsureCodexClientOptions } from './client-construction';

/** Return the session client, constructing it with a frozen per-session environment on a miss. */
export function ensureCodexClient({
  clients,
  sessionId,
  sessionToken,
  hookServer,
}: EnsureCodexClientOptions): CodexAppServerClient {
  return ensureCodexClientWithHost(
    { clients, sessionId, sessionToken, hookServer },
    desktopCodexClientConstructionHost,
  );
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
      return codexUsageUnavailableSnapshot();
    }
    return errorUsageSnapshot('codex-cli', err);
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
