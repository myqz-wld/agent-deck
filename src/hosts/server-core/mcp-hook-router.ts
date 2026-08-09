import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { RouteOptions } from 'fastify';

const MAX_HOOK_BODY_BYTES = 256 * 1024;
const MAX_HOOK_ROUTES = 64;
const HOOK_ROUTE = /^\/hook\/[a-z0-9/-]+$/;

interface RegisteredHookRoute {
  readonly adapterId: string;
  readonly route: RouteOptions;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.byteLength;
    if (total > MAX_HOOK_BODY_BYTES) throw new Error('request-too-large');
    chunks.push(value);
  }
  if (total === 0) throw new Error('request-body-empty');
  return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown;
}

function isPost(method: RouteOptions['method']): boolean {
  return method === 'POST' || (Array.isArray(method) && method.length === 1 && method[0] === 'POST');
}

/** Executes the existing provider hook routes on the Core-owned loopback broker. */
export class ServerCoreHookRouter {
  private readonly expectedAuthorization: Buffer;
  private readonly routes = new Map<string, RegisteredHookRoute>();

  constructor(token: string) {
    if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Core hook token is invalid');
    this.expectedAuthorization = Buffer.from(`Bearer ${token}`);
  }

  registerForAdapter(adapterId: string, route: RouteOptions): void {
    if (!/^[a-z0-9-]{1,64}$/.test(adapterId)) {
      throw new Error('Core hook adapter identity is invalid');
    }
    if (
      this.routes.size >= MAX_HOOK_ROUTES ||
      typeof route.url !== 'string' ||
      !HOOK_ROUTE.test(route.url) ||
      !isPost(route.method) ||
      typeof route.handler !== 'function'
    ) {
      throw new Error('Core hook route is invalid');
    }
    if (this.routes.has(route.url)) throw new Error('Core hook route is duplicated');
    this.routes.set(route.url, Object.freeze({ adapterId, route }));
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = request.url?.split('?', 1)[0] ?? '';
    if (!path.startsWith('/hook/')) return false;
    if (!this.authorized(request.headers.authorization)) {
      sendJson(response, 401, { ok: false, error: 'unauthorized' });
      return true;
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: 'method-not-allowed' });
      return true;
    }
    const registered = this.routes.get(path);
    if (!registered) {
      sendJson(response, 404, { ok: false, error: 'not-found' });
      return true;
    }
    let body: unknown;
    try {
      body = await readJson(request);
    } catch (error) {
      sendJson(response, error instanceof Error && error.message === 'request-too-large'
        ? 413
        : 400, { ok: false, error: 'invalid hook payload' });
      return true;
    }
    let status = 200;
    let sent = false;
    const reply = {
      code: (next: number) => {
        status = Number.isInteger(next) && next >= 100 && next <= 599 ? next : 500;
        return reply;
      },
      send: (value: unknown) => {
        sent = true;
        sendJson(response, status, value);
        return reply;
      },
    };
    try {
      const handler = registered.route.handler as unknown as (
        request: unknown,
        reply: unknown,
      ) => unknown;
      await handler(
        { body, headers: request.headers } as never,
        reply as never,
      );
      if (!sent) sendJson(response, 204, null);
    } catch {
      sendJson(response, 500, { ok: false, error: 'hook processing failed' });
    }
    return true;
  }

  private authorized(value: string | string[] | undefined): boolean {
    const candidate = Buffer.from(typeof value === 'string' ? value : '');
    return candidate.byteLength === this.expectedAuthorization.byteLength &&
      timingSafeEqual(candidate, this.expectedAuthorization);
  }
}
