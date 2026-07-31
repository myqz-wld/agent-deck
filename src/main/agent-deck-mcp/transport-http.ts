/**
 * Stateless Agent Deck MCP HTTP transport.
 *
 * HookServer authenticates requests before these routes run. Every POST owns a fresh SDK server
 * and transport, while the response close event owns their cleanup. GET and DELETE remain fixed
 * 405 responses because protocol-level sessions are intentionally disabled.
 */

import type { RouteRegistry } from '@main/hook-server/route-registry';
import { isSessionAdapterId } from '@main/adapters/runtime-profiles';
import { sessionRepo } from '@main/store/session-repo';
import type { SessionAdapterId } from '@shared/types';
import {
  registerAgentDeckToolDefinitions,
  type AgentDeckMcpServerModule,
} from './server';
import { buildAgentDeckTools } from './tools';
import { EXTERNAL_CALLER_SENTINEL, type McpAuthInfo } from './types';
import {
  classifyMcpHttpMethod,
  mcpHttpTransportObserver,
  type McpHttpObservation,
  type McpHttpObserver,
} from './transport-http-observability';

const dynamicImport = new Function('s', 'return import(s)') as <T = unknown>(
  s: string,
) => Promise<T>;

interface McpStreamableHttpModule {
  StreamableHTTPServerTransport: new (options: {
    sessionIdGenerator: (() => string) | undefined;
  }) => {
    handleRequest: (req: unknown, res: unknown, body?: unknown) => Promise<void>;
    close: () => Promise<void>;
  };
}

let cachedMcpSdk: {
  server: AgentDeckMcpServerModule;
  http: McpStreamableHttpModule;
} | null = null;

async function loadMcpSdk(): Promise<{
  server: AgentDeckMcpServerModule;
  http: McpStreamableHttpModule;
}> {
  if (!cachedMcpSdk) {
    const [server, http] = await Promise.all([
      dynamicImport<AgentDeckMcpServerModule>(
        '@modelcontextprotocol/sdk/server/mcp.js',
      ),
      dynamicImport<McpStreamableHttpModule>(
        '@modelcontextprotocol/sdk/server/streamableHttp.js',
      ),
    ]);
    cachedMcpSdk = { server, http };
  }
  return cachedMcpSdk;
}

/**
 * Resolve the authenticated HTTP caller. Global-token and missing-auth paths are always external,
 * so caller-supplied arguments cannot impersonate an application session.
 */
export function resolveCallerSidForReadOnly(extra?: unknown): string {
  const authInfo = (extra as { authInfo?: McpAuthInfo } | undefined)?.authInfo;
  if (authInfo?.fallbackToGlobal) return EXTERNAL_CALLER_SENTINEL;
  return authInfo?.resolvedSid ?? EXTERNAL_CALLER_SENTINEL;
}

export function resolveAuthenticatedAdapterId(
  authInfo: McpAuthInfo | undefined,
): SessionAdapterId | null {
  if (!authInfo?.resolvedSid || authInfo.fallbackToGlobal) return null;
  const agentId = sessionRepo.get(authInfo.resolvedSid)?.agentId;
  return agentId && isSessionAdapterId(agentId) ? agentId : null;
}

/** Build a fresh SDK server and register the tools visible to the authenticated adapter. */
export async function buildAgentDeckMcpServerForExternalTransport(
  transportName: 'http',
  adapterId: SessionAdapterId | null,
  mcpServerModule?: AgentDeckMcpServerModule,
) {
  const server = mcpServerModule ?? (await loadMcpSdk()).server;
  const mcpServer = new server.McpServer({
    name: 'agent-deck',
    version: '0.1.0',
  });
  const adapted = await buildAgentDeckTools({
    callerSessionIdOverride: resolveCallerSidForReadOnly,
    transport: transportName,
    adapterId,
  });
  registerAgentDeckToolDefinitions(mcpServer, adapted);
  return mcpServer;
}

interface McpHttpTransportInstance {
  handleRequest: (req: unknown, res: unknown, body?: unknown) => Promise<void>;
  close: () => Promise<void>;
}

interface McpHttpServerInstance {
  connect: (transport: unknown) => Promise<void>;
  close: () => Promise<void>;
}

export interface McpHttpRouteDependencies {
  loadSdk: () => Promise<{
    http: {
      StreamableHTTPServerTransport: new (options: {
        sessionIdGenerator: (() => string) | undefined;
      }) => McpHttpTransportInstance;
    };
  }>;
  buildServer: (
    transportName: 'http' | 'stdio',
    adapterId: SessionAdapterId | null,
  ) => Promise<McpHttpServerInstance>;
  observer: McpHttpObserver;
}

/**
 * Register the stateless POST/GET/DELETE routes. Optional dependencies are a listener-free test
 * seam; production callers use the cached SDK loader, server builder, and shared observer.
 */
export async function registerAgentDeckMcpHttpRoutes(
  routeRegistry: RouteRegistry,
  overrides: Partial<McpHttpRouteDependencies> = {},
): Promise<{ shutdown: () => Promise<void> }> {
  const loadSdk = overrides.loadSdk ?? loadMcpSdk;
  const buildServer =
    overrides.buildServer ?? buildAgentDeckMcpServerForExternalTransport;
  const observer = overrides.observer ?? mcpHttpTransportObserver;
  const { http } = await loadSdk();

  routeRegistry.registerForAdapter('agent-deck-mcp', {
    method: 'POST',
    url: '/mcp',
    handler: async (req, reply) => {
      const body = req.body as unknown;
      const observation = safeBeginObservation(observer, body);

      const authInfo = (req.raw as { auth?: McpAuthInfo }).auth;
      const transport = new http.StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const mcpServer = await buildServer(
        'http',
        resolveAuthenticatedAdapterId(authInfo),
      );
      await (
        mcpServer as unknown as { connect: (value: unknown) => Promise<void> }
      ).connect(transport);

      // Streaming completion owns cleanup; failures are swallowed to avoid unhandled rejections.
      reply.raw.on('close', () => {
        Promise.resolve()
          .then(async () => {
            try {
              await transport.close();
            } catch {
              // Cleanup is best-effort.
            }
            try {
              await (
                mcpServer as unknown as { close: () => Promise<void> }
              ).close();
            } catch {
              // Cleanup is best-effort.
            }
          })
          .catch(() => {
            // Cleanup is best-effort.
          });
      });
      // Cleanup is registered first so diagnostics can never preempt its close listener.
      attachResponseObservation(reply.raw, observer, observation);

      try {
        await transport.handleRequest(req.raw, reply.raw, body);
      } catch (error) {
        // Preserve the SDK example's parseable fallback if no response has started.
        if (!reply.raw.headersSent) {
          reply.raw.statusCode = 500;
          reply.raw.setHeader('content-type', 'application/json');
          reply.raw.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32603,
                message:
                  'Internal server error: ' +
                  (error instanceof Error ? error.message : String(error)),
              },
              id: null,
            }),
          );
        } else if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
      // The SDK writes directly to the raw response.
      reply.hijack();
    },
  });

  for (const method of ['GET', 'DELETE'] as const) {
    routeRegistry.registerForAdapter('agent-deck-mcp', {
      method,
      url: '/mcp',
      handler: async (_req, reply) => {
        const observation = safeBeginOperation(
          observer,
          classifyMcpHttpMethod(method),
        );
        attachResponseObservation(reply.raw, observer, observation);
        reply.raw.statusCode = 405;
        reply.raw.setHeader('content-type', 'application/json');
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message:
                'Method not allowed (stateless mode: GET/DELETE not supported, POST only).',
            },
            id: null,
          }),
        );
        reply.hijack();
      },
    });
  }

  return {
    // Per-request resources close with their response; no global transport exists.
    shutdown: async () => {},
  };
}

function safeBeginObservation(
  observer: McpHttpObserver,
  body: unknown,
): McpHttpObservation | null {
  try {
    return observer.begin(body);
  } catch {
    return null;
  }
}

function safeBeginOperation(
  observer: McpHttpObserver,
  operation: ReturnType<typeof classifyMcpHttpMethod>,
): McpHttpObservation | null {
  try {
    return observer.beginOperation(operation);
  } catch {
    return null;
  }
}

/**
 * Observe finish exactly once; a close before a completed response is an abort. Every accessor and
 * observer call is isolated so diagnostics cannot alter response or cleanup event delivery.
 */
function attachResponseObservation(
  raw: unknown,
  observer: McpHttpObserver,
  observation: McpHttpObservation | null,
): void {
  if (!observation) return;
  try {
    const response = raw as {
      once: (event: 'finish' | 'close', listener: () => void) => unknown;
      statusCode?: unknown;
      writableFinished?: unknown;
    };
    let completed = false;
    const completeResponse = (): void => {
      if (completed) return;
      completed = true;
      const statusCode = safeRead(response, 'statusCode');
      if (!statusCode.ok) return;
      safeComplete(observer, observation, {
        kind: 'response',
        statusCode: statusCode.value,
      });
    };
    const completeClose = (): void => {
      if (completed) return;
      completed = true;
      const writableFinished = safeRead(response, 'writableFinished');
      if (!writableFinished.ok) return;
      const finished = writableFinished.value === true;
      const statusCode = finished ? safeRead(response, 'statusCode') : null;
      if (statusCode && !statusCode.ok) return;
      safeComplete(
        observer,
        observation,
        finished
          ? {
              kind: 'response',
              statusCode: statusCode?.value,
            }
          : { kind: 'client_aborted' },
      );
    };
    response.once('finish', completeResponse);
    response.once('close', completeClose);
  } catch {
    // Observability is best-effort.
  }
}

function safeComplete(
  observer: McpHttpObserver,
  observation: McpHttpObservation,
  completion:
    | { kind: 'response'; statusCode: unknown }
    | { kind: 'client_aborted' },
): void {
  try {
    observer.complete(observation, completion);
  } catch {
    // Observability is best-effort.
  }
}

function safeRead(
  response: {
    statusCode?: unknown;
    writableFinished?: unknown;
  },
  field: 'statusCode' | 'writableFinished',
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: response[field] };
  } catch {
    return { ok: false };
  }
}
