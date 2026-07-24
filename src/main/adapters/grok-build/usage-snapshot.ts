import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ProviderUsageSnapshot } from '@shared/types';
import { getProviderUsageProbeCwd } from '@main/paths';
import log from '@main/utils/logger';
import {
  buildGrokUsageSnapshot,
  errorUsageSnapshot,
  unavailableUsageSnapshot,
  type GrokBillingResponseLike,
} from '../provider-usage';
import { GrokAcpProcess } from './acp-process';
import { resolveGrokBinary } from './resolve-grok-binary';

const logger = log.scope('grok-usage');
const DEFAULT_GROK_BILLING_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
const BACKGROUND_USAGE_TIMEOUT_MS = 15_000;
const GROK_USAGE_UNAVAILABLE_MESSAGE =
  'Grok 额度信息暂不可读，请确认 Grok 已登录且网络可用';

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GrokUsageProbeDeps {
  binaryPath?: string | null;
  authPath?: string;
  endpoint?: string;
  fetchFn?: FetchLike;
  readAccessTokenFn?: () => Promise<string | null>;
  refreshAuthFn?: () => Promise<void>;
  getProbeCwdFn?: typeof getProviderUsageProbeCwd;
  timeoutMs?: number;
}

/** Read Grok's own cached login token without persisting or logging it in Agent Deck. */
export async function readGrokCachedAccessToken(
  authPath = defaultGrokAuthPath(),
): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(authPath, 'utf8')) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const candidates: Array<{ token: string; expiresAt: number }> = [];
  for (const entry of Object.values(parsed as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const value = entry as Record<string, unknown>;
    const token =
      typeof value.key === 'string' && value.key.trim()
        ? value.key.trim()
        : null;
    if (!token) continue;
    const expiresAt =
      typeof value.expires_at === 'string'
        ? new Date(value.expires_at).getTime()
        : 0;
    candidates.push({
      token,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    });
  }
  candidates.sort((a, b) => b.expiresAt - a.expiresAt);
  return candidates[0]?.token ?? null;
}

export async function readGrokUsageSnapshotInBackground(
  deps: GrokUsageProbeDeps = {},
): Promise<ProviderUsageSnapshot> {
  const readAccessToken =
    deps.readAccessTokenFn ??
    (() => readGrokCachedAccessToken(deps.authPath ?? defaultGrokAuthPath()));
  const refreshAuth =
    deps.refreshAuthFn ??
    (() =>
      refreshGrokAuthentication(
        deps.binaryPath ?? null,
        (deps.getProbeCwdFn ?? getProviderUsageProbeCwd)(),
      ));
  const fetchFn = deps.fetchFn ?? fetch;
  const endpoint = deps.endpoint ?? defaultGrokBillingEndpoint();
  const timeoutMs = deps.timeoutMs ?? BACKGROUND_USAGE_TIMEOUT_MS;

  try {
    let token = await readAccessToken();
    if (!token) {
      await refreshAuth();
      token = await readAccessToken();
    }
    if (!token) throw new Error('Grok authentication required');

    let response = await fetchGrokBilling(fetchFn, endpoint, token, timeoutMs);
    if (response.status === 401 || response.status === 403) {
      await refreshAuth();
      token = await readAccessToken();
      if (!token) throw new Error('Grok authentication required');
      response = await fetchGrokBilling(fetchFn, endpoint, token, timeoutMs);
    }
    if (!response.ok) {
      throw new Error(`Grok billing service returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Grok billing service returned an invalid response');
    }
    return buildGrokUsageSnapshot(payload as GrokBillingResponseLike);
  } catch (error) {
    if (isExpectedGrokUsageUnavailable(error)) {
      logger.debug('[grok-usage] usage snapshot unavailable:', error);
      return unavailableUsageSnapshot(
        'grok-build',
        'Grok',
        GROK_USAGE_UNAVAILABLE_MESSAGE,
      );
    }
    logger.warn('[grok-usage] usage snapshot failed:', error);
    return errorUsageSnapshot('grok-build', 'Grok', error);
  }
}

function defaultGrokAuthPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const root = env.GROK_HOME?.trim();
  return join(root ? resolve(root) : join(homedir(), '.grok'), 'auth.json');
}

function defaultGrokBillingEndpoint(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const base =
    env.CLI_CHAT_PROXY_BASE_URL?.trim() ||
    DEFAULT_GROK_BILLING_BASE_URL;
  return `${base.replace(/\/+$/, '')}/billing?format=credits`;
}

function fetchGrokBilling(
  fetchFn: FetchLike,
  endpoint: string,
  token: string,
  timeoutMs: number,
): Promise<Response> {
  return fetchFn(endpoint, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'x-grok-client-mode': 'agent-deck',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function refreshGrokAuthentication(
  configuredBinary: string | null,
  cwd: string,
): Promise<void> {
  const binary = await resolveGrokBinary(configuredBinary);
  const child = await GrokAcpProcess.start({
    binary,
    cwd,
    onSessionUpdate: () => undefined,
    onPermissionRequest: async () => ({
      outcome: { outcome: 'cancelled' },
    }),
  });
  await child.stop();
}

function isExpectedGrokUsageUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\bauthentication required\b/i.test(message) ||
    /\b(auth|login|not authenticated|unauthorized)\b/i.test(message) ||
    /\b(401|403)\b/.test(message)
  );
}
