import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import type { CodexThreadOptions } from '../sdk-bridge/thread-options-builder';
import type { JsonObject, JsonValue } from './protocol';
import { buildThreadConfig } from './thread-params';

const NODE_REPL_SERVER_NAME = 'node_repl';
export const NODE_REPL_BROWSER_PROXY_FILENAME = 'node-repl-browser-bootstrap.cjs';

export interface NodeReplBrowserBootstrapClient {
  readonly generation: number;
  request<T = unknown>(method: string, params: unknown): Promise<T>;
}

export interface NodeReplBrowserBootstrapOperation {
  isCurrent(): boolean;
  request<T = unknown>(method: string, params: unknown): Promise<T>;
}

export type NodeReplBrowserBootstrapDiagnostic =
  | { type: 'config-read-failed'; error: unknown }
  | { type: 'installed' };

export interface NodeReplBrowserBootstrapPorts {
  executablePath: string;
  proxyPath: string;
  diagnose?(diagnostic: NodeReplBrowserBootstrapDiagnostic): void;
}

interface ConfigReadResponse {
  config?: JsonObject;
}

interface EffectiveConfigCache {
  generation: number;
  byCwd: Map<string, Promise<JsonObject>>;
}

const effectiveConfigCache = new WeakMap<
  NodeReplBrowserBootstrapClient,
  EffectiveConfigCache
>();

/** Inject the Browser client's required process-facade preload into a local node_repl server. */
export async function prepareNodeReplBrowserBootstrapPolicy(
  client: NodeReplBrowserBootstrapClient,
  options: CodexThreadOptions,
  baseConfig: CodexConfigObject | null,
  ports: NodeReplBrowserBootstrapPorts,
  operation?: NodeReplBrowserBootstrapOperation,
): Promise<CodexThreadOptions> {
  const explicitConfig = buildThreadConfig(options, baseConfig);
  let inheritedConfig: JsonObject = {};
  if (options.useBaseConfig !== false) {
    try {
      inheritedConfig = await readEffectiveConfig(
        client,
        options.workingDirectory,
        operation,
      );
    } catch (error) {
      if (operation && !operation.isCurrent()) throw error;
      safelyDiagnose(ports, { type: 'config-read-failed', error });
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
  ) {
    return options;
  }
  const command = typeof server.command === 'string' ? server.command.trim() : '';
  if (!command) return options;

  const currentArgs = readStringArray(server.args);
  if (command === ports.executablePath && currentArgs[0] === ports.proxyPath) return options;

  const wrappedServer = buildWrappedServer(
    server,
    command,
    currentArgs,
    ports.executablePath,
    ports.proxyPath,
  );
  const overrides = mergeJsonObjects(cloneJsonObject(options.configOverrides ?? null), {
    mcp_servers: { [NODE_REPL_SERVER_NAME]: wrappedServer },
  });
  safelyDiagnose(ports, { type: 'installed' });
  return { ...options, configOverrides: overrides as CodexConfigObject };
}

async function readEffectiveConfig(
  client: NodeReplBrowserBootstrapClient,
  cwd: string,
  operation?: NodeReplBrowserBootstrapOperation,
): Promise<JsonObject> {
  let cache = effectiveConfigCache.get(client);
  if (!cache || cache.generation !== client.generation) {
    cache = { generation: client.generation, byCwd: new Map() };
    effectiveConfigCache.set(client, cache);
  }
  const cached = cache.byCwd.get(cwd);
  if (cached) return cached;

  const request = (operation
    ? operation.request<ConfigReadResponse>('config/read', { includeLayers: false, cwd })
    : client.request<ConfigReadResponse>('config/read', { includeLayers: false, cwd }))
    .then((response) => isJsonObject(response.config) ? response.config : {});
  cache.byCwd.set(cwd, request);
  try {
    return await request;
  } catch (error) {
    if (cache.byCwd.get(cwd) === request) cache.byCwd.delete(cwd);
    throw error;
  }
}

function buildWrappedServer(
  server: JsonObject,
  command: string,
  args: string[],
  executablePath: string,
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
    command: executablePath,
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
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function readStringMap(value: JsonValue | undefined): Record<string, string> {
  if (!isJsonObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
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

function safelyDiagnose(
  ports: NodeReplBrowserBootstrapPorts,
  diagnostic: NodeReplBrowserBootstrapDiagnostic,
): void {
  try {
    ports.diagnose?.(diagnostic);
  } catch {
    // Host diagnostics cannot alter Browser bootstrap policy.
  }
}
