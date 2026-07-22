import { join } from 'node:path';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import { resolveAgentDeckResourcesRoot } from '@main/utils/resources-placeholder';
import log from '@main/utils/logger';
import type { CodexThreadOptions } from '../sdk-bridge/thread-options-builder';
import type { CodexAppServerClient } from './client';
import type { JsonObject, JsonValue } from './protocol';
import { buildThreadConfig } from './thread-params';

const logger = log.scope('codex-node-repl-compat');
const NODE_REPL_SERVER_NAME = 'node_repl';
const PROXY_FILENAME = 'node-repl-sandbox-meta-proxy.cjs';

interface ConfigReadResponse {
  config?: JsonObject;
}

interface EffectiveConfigCache {
  generation: number;
  byCwd: Map<string, Promise<JsonObject>>;
}

const effectiveConfigCache = new WeakMap<CodexAppServerClient, EffectiveConfigCache>();

/**
 * Wrap the configured node_repl stdio server with Agent Deck's protocol bridge.
 *
 * Codex 0.142+ sends permissionProfile in codex/sandbox-state-meta, while older browser-bundled
 * node_repl builds require the legacy sandboxPolicy field. The bridge retries only the exact
 * legacy schema error and derives the missing field from the request's canonical profile.
 */
export async function prepareNodeReplCompatibility(
  client: CodexAppServerClient,
  options: CodexThreadOptions,
  baseConfig: CodexConfigObject | null,
): Promise<CodexThreadOptions> {
  const explicitConfig = buildThreadConfig(options, baseConfig);
  let inheritedConfig: JsonObject = {};
  if (options.useBaseConfig !== false) {
    try {
      inheritedConfig = await readEffectiveConfig(client, options.workingDirectory);
    } catch (err) {
      logger.warn('[node-repl-compat] config/read failed; leaving node_repl unchanged', err);
      return options;
    }
  }

  const inheritedServer = readNodeReplServer(inheritedConfig);
  const explicitServer = readNodeReplServer(explicitConfig);
  if (!inheritedServer && !explicitServer) return options;

  const server = mergeJsonObjects(inheritedServer ?? {}, explicitServer ?? {});
  const environmentId = server.environment_id;
  if (
    server.enabled === false ||
    (typeof environmentId === 'string' && environmentId !== 'local')
  ) return options;
  const command = typeof server.command === 'string' ? server.command.trim() : '';
  if (!command) return options;

  const proxyPath = join(resolveAgentDeckResourcesRoot(), 'bin', PROXY_FILENAME);
  const currentArgs = readStringArray(server.args);
  if (command === process.execPath && currentArgs[0] === proxyPath) return options;

  const wrappedServer = buildWrappedServer(server, command, currentArgs, proxyPath);
  const overrides = mergeJsonObjects(cloneJsonObject(options.configOverrides ?? null), {
    mcp_servers: { [NODE_REPL_SERVER_NAME]: wrappedServer },
  });
  logger.debug('[node-repl-compat] installed sandbox metadata bridge for node_repl');
  return { ...options, configOverrides: overrides as CodexConfigObject };
}

async function readEffectiveConfig(
  client: CodexAppServerClient,
  cwd: string,
): Promise<JsonObject> {
  let cache = effectiveConfigCache.get(client);
  if (!cache || cache.generation !== client.generation) {
    cache = { generation: client.generation, byCwd: new Map() };
    effectiveConfigCache.set(client, cache);
  }
  const cached = cache.byCwd.get(cwd);
  if (cached) return cached;

  const request = client
    .request<ConfigReadResponse>('config/read', { includeLayers: false, cwd })
    .then((response) => isJsonObject(response.config) ? response.config : {});
  cache.byCwd.set(cwd, request);
  try {
    return await request;
  } catch (err) {
    if (cache.byCwd.get(cwd) === request) cache.byCwd.delete(cwd);
    throw err;
  }
}

function buildWrappedServer(
  server: JsonObject,
  command: string,
  args: string[],
  proxyPath: string,
): JsonObject {
  const cleaned = stripNulls(server) as JsonObject;
  const originalEnv = readStringMap(cleaned.env);
  const payload = Buffer.from(JSON.stringify({
    command,
    args,
    electronRunAsNode: originalEnv.ELECTRON_RUN_AS_NODE ?? null,
  }), 'utf8').toString('base64url');

  return {
    ...cleaned,
    command: process.execPath,
    args: [proxyPath, payload],
    env: { ...originalEnv, ELECTRON_RUN_AS_NODE: '1' },
  };
}

function readNodeReplServer(config: JsonObject): JsonObject | null {
  const servers = config.mcp_servers;
  if (!isJsonObject(servers)) return null;
  const server = servers[NODE_REPL_SERVER_NAME];
  return isJsonObject(server) ? server : null;
}

function readStringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readStringMap(value: JsonValue | undefined): Record<string, string> {
  if (!isJsonObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function cloneJsonObject(value: CodexConfigObject | null): JsonObject {
  return value ? JSON.parse(JSON.stringify(value)) as JsonObject : {};
}

function mergeJsonObjects(target: JsonObject, override: JsonObject): JsonObject {
  const merged = { ...target };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const existing = merged[key];
    merged[key] = isJsonObject(existing) && isJsonObject(value)
      ? mergeJsonObjects(existing, value)
      : value;
  }
  return merged;
}

function stripNulls(value: JsonValue | undefined): JsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.map(stripNulls).filter((item): item is JsonValue => item !== undefined);
  }
  if (!isJsonObject(value)) return value;
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    const cleaned = stripNulls(item);
    if (cleaned !== undefined) output[key] = cleaned;
  }
  return output;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export const __testables = {
  buildWrappedServer,
  mergeJsonObjects,
  readNodeReplServer,
};
