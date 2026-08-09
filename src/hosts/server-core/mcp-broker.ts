import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import { isSessionAdapterId } from '@main/adapters/runtime-profiles';

import type { ServerCoreMcpBrokerPort } from './mcp-broker-port';
import { ServerCoreHookRouter } from './mcp-hook-router';
import {
  createServerCoreInProcessMcpServer,
  createServerCoreMcpServer,
  type ServerCoreMcpServerModule,
} from './mcp-server';
import type { ServerCoreMcpToolHost } from './mcp-tool-host';
import type { ServerCoreRuntimeDiagnostics } from './repository-host';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_CONNECTIONS = 64;
const REQUEST_TIMEOUT_MS = 60_000;
const dynamicImport = new Function('s', 'return import(s)') as <T = unknown>(
  specifier: string,
) => Promise<T>;

export interface ServerCoreStreamableHttpModule {
  StreamableHTTPServerTransport: new (options: {
    sessionIdGenerator: undefined;
  }) => {
    handleRequest(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void>;
    close(): Promise<void>;
  };
}

interface ActiveResource {
  close(): Promise<void>;
}

export interface ServerCoreMcpBrokerOptions {
  readonly host: ServerCoreMcpToolHost;
  readonly diagnostics: ServerCoreRuntimeDiagnostics;
  readonly loadMcpSdk?: () => Promise<{
    server: ServerCoreMcpServerModule;
    http: ServerCoreStreamableHttpModule;
  }>;
}

function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error('request-too-large');
    chunks.push(value);
  }
  if (total === 0) throw new Error('request-body-empty');
  return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown;
}

/** Core-owned loopback MCP broker. It accepts only live per-session bearer tokens. */
export class ServerCoreMcpBroker implements ServerCoreMcpBrokerPort {
  readonly bearerToken = randomBytes(32).toString('hex');
  readonly mcpBearerToken = randomBytes(32).toString('hex');
  private readonly server: Server;
  private readonly hookRouter: ServerCoreHookRouter;
  private readonly active = new Set<ActiveResource>();
  private state: 'idle' | 'starting' | 'running' | 'closing' | 'closed' = 'idle';
  private port = 0;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private sdkPromise: Promise<{
    server: ServerCoreMcpServerModule;
    http: ServerCoreStreamableHttpModule;
  }> | null = null;

  constructor(private readonly options: ServerCoreMcpBrokerOptions) {
    this.hookRouter = new ServerCoreHookRouter(this.bearerToken);
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        jsonResponse(response, 500, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: 'Server Core MCP request failed' },
        });
      });
    });
    this.server.maxConnections = MAX_CONNECTIONS;
    this.server.maxHeadersCount = 32;
    this.server.requestTimeout = REQUEST_TIMEOUT_MS;
    this.server.headersTimeout = Math.min(REQUEST_TIMEOUT_MS, 30_000);
    this.server.keepAliveTimeout = 5_000;
  }

  get isRunning(): boolean {
    return this.state === 'running';
  }

  get listeningPort(): number {
    return this.port;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.state !== 'idle') return Promise.reject(new Error('Core MCP broker is closed'));
    this.state = 'starting';
    this.startPromise = new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off('listening', onListening);
        this.state = 'closed';
        reject(error);
      };
      const onListening = (): void => {
        this.server.off('error', onError);
        const address = this.server.address();
        if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
          this.state = 'closed';
          reject(new Error('Core MCP broker did not bind the loopback boundary'));
          return;
        }
        this.port = address.port;
        this.state = 'running';
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen({ host: '127.0.0.1', port: 0 });
    });
    return this.startPromise;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOwned();
    return this.stopPromise;
  }

  createInProcessServer(
    callerSessionId: () => string,
    adapterId: Parameters<ServerCoreMcpBrokerPort['createInProcessServer']>[1],
  ) {
    return createServerCoreInProcessMcpServer(this.options.host, callerSessionId, adapterId);
  }

  registerForAdapter(
    adapterId: string,
    route: Parameters<ServerCoreMcpBrokerPort['registerForAdapter']>[1],
  ): void {
    if (this.state === 'closing' || this.state === 'closed') {
      throw new Error('Core hook broker is closed');
    }
    this.hookRouter.registerForAdapter(adapterId, route);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.state !== 'running') {
      jsonResponse(response, 503, { error: 'broker-unavailable' });
      return;
    }
    if (await this.hookRouter.handle(request, response)) return;
    if (request.url !== '/mcp') {
      jsonResponse(response, 404, { error: 'not-found' });
      return;
    }
    if (request.method !== 'POST') {
      jsonResponse(response, 405, { error: 'method-not-allowed' });
      return;
    }
    const caller = this.authenticate(request);
    if (!caller) {
      jsonResponse(response, 401, { error: 'unauthorized' });
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      jsonResponse(response, error instanceof Error && error.message === 'request-too-large'
        ? 413
        : 400, { error: 'invalid-request' });
      return;
    }
    const sdk = await this.loadMcpSdk();
    const { StreamableHTTPServerTransport } = sdk.http;
    const mcpServer = await createServerCoreMcpServer(
      this.options.host,
      () => caller.sessionId,
      caller.adapterId,
      sdk.server,
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcpServer.connect(
      transport as unknown as Parameters<typeof mcpServer.connect>[0],
    );
    let closed = false;
    const resource: ActiveResource = {
      close: async () => {
        if (closed) return;
        closed = true;
        this.active.delete(resource);
        await Promise.allSettled([transport.close(), mcpServer.close()]);
      },
    };
    this.active.add(resource);
    response.once('close', () => { void resource.close(); });
    try {
      await transport.handleRequest(request, response, body);
    } catch {
      jsonResponse(response, 500, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: 'Server Core MCP request failed' },
      });
    }
  }

  private authenticate(request: IncomingMessage): {
    sessionId: string;
    adapterId: 'claude-code' | 'codex-cli' | 'grok-build';
  } | null {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ') || authorization.length > 512) return null;
    const token = authorization.slice('Bearer '.length);
    const sessionId = mcpSessionTokenMap.get(token);
    if (!sessionId) return null;
    const session = this.options.host.sessions.get(sessionId);
    if (!session || session.lifecycle === 'closed' || session.archivedAt !== null ||
        !isSessionAdapterId(session.agentId)) {
      return null;
    }
    return { sessionId, adapterId: session.agentId };
  }

  private loadMcpSdk(): Promise<{
    server: ServerCoreMcpServerModule;
    http: ServerCoreStreamableHttpModule;
  }> {
    this.sdkPromise ??= this.options.loadMcpSdk?.() ?? Promise.all([
      dynamicImport<ServerCoreMcpServerModule>(
        '@modelcontextprotocol/sdk/server/mcp.js',
      ),
      dynamicImport<ServerCoreStreamableHttpModule>(
        '@modelcontextprotocol/sdk/server/streamableHttp.js',
      ),
    ]).then(([server, http]) => ({ server, http }));
    return this.sdkPromise;
  }

  private async stopOwned(): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    if (this.state === 'closed') return;
    if (this.state === 'idle') {
      this.state = 'closed';
      return;
    }
    this.state = 'closing';
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeIdleConnections?.();
      this.server.closeAllConnections?.();
    });
    await Promise.allSettled([...this.active].map((resource) => resource.close()));
    this.active.clear();
    this.port = 0;
    this.state = 'closed';
  }
}
