/**
 * mcp-sdk 1.29 StreamableHTTPServerTransport multi-client init 行为实证
 *
 * 目的：实证 plan reviewer-codex-cross-adapter-20260519 Phase 0 Step 0.4 — Step 0.3 fix
 * (commit c67ddde, sessionIdGenerator: undefined stateless 模式) 是否真解 spike 1+2 的
 * "Server already initialized" 撞错。**结论：fix c67ddde 不充分,需走 fix 路径 B**。
 *
 * 实测三档行为:
 * 1. STATEFUL（sessionIdGenerator 非 undefined）+ 单 transport reuse → 第二次 init 撞
 *    -32600 "Server already initialized"（spike 1+2 已实测 root cause,本 test reproduce 守 regression）
 * 2. STATELESS（sessionIdGenerator: undefined）+ 单 transport reuse → 第二次 init 撞
 *    "Stateless transport cannot be reused across requests"（mcp-sdk webStandardStreamableHttp.js:142-144
 *    throw）, hono `handleFetchError` 把 throw 转成 status=500 + 空 body（hono node-server
 *    listener.js:518 + 441）。fix c67ddde **新 bug** — multi-client init 仍 broken,只是错码换成 500。
 * 3. STATELESS + per-request fresh transport instance → 两次 init 都 200（fix 路径 B 可行）
 *
 * 实测套路：起真 http.Server，挂 transport.handleRequest 到 listener，发真 fetch initialize
 * request 实测 multi-client 行为（IncomingMessage / ServerResponse mock 不够，hono
 * getRequestListener 内部需真 Node http 请求语义 / socket）。
 */

import { describe, expect, it, afterEach } from 'vitest';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

// 加载 mcp-sdk StreamableHTTPServerTransport — 走 createRequire 直接 require subpath，
// 绕开 vite 静态 resolver / vitest dynamic import callback 限制。production transport-http.ts
// 用 `new Function('s','return import(s)')` 在 electron main 进程跑（V8 dynamic import
// callback 已设置），但 vitest 跑 v8/node 默认 dynamic callback 未注册。test 走 require 兜底。
const requireFromTest = createRequire(import.meta.url);
function loadStreamableHttpTransport() {
  const mod = requireFromTest(
    '@modelcontextprotocol/sdk/server/streamableHttp.js',
  );
  return mod.StreamableHTTPServerTransport;
}
function loadMcpServer() {
  const mod = requireFromTest('@modelcontextprotocol/sdk/server/mcp.js');
  return mod.McpServer;
}

interface TestServer {
  url: string;
  shutdown: () => Promise<void>;
}

/**
 * 起真 http server,挂 transport.handleRequest 到 / route。
 * - getTransport: 工厂回调 — server 在 request 进入时调用拿当前 transport instance
 *   （让 test 1+2 复用同一 instance,test 3 每次返 fresh 实例）
 */
async function startServer(getTransport: () => any): Promise<TestServer> {
  const server = http.createServer(async (req, res) => {
    let body: any;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = undefined;
    }
    const transport = getTransport();
    try {
      await transport.handleRequest(req, res, body);
    } catch (e) {
      // production 路径下 throw 不会到这里(hono getRequestListener 内部
      // res.catch(handleFetchError) 把 fetchCallback throw 转成 status=500 空 body)
      // 防御兜底
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: (e as Error).message }));
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server.address() invalid');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    shutdown: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

const initRequestBody = (id: string | number) => ({
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.1' },
  },
  id,
});

async function postInit(
  url: string,
  id: number,
): Promise<{ status: number; bodyText: string; bodyJson: any }> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(initRequestBody(id)),
  });
  const bodyText = await resp.text();
  let bodyJson: any = null;
  try {
    bodyJson = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    bodyJson = null;
  }
  return { status: resp.status, bodyText, bodyJson };
}

/**
 * Connect a fresh McpServer instance to a transport (mcp-sdk requires McpServer.connect
 * before transport accepts requests).
 */
async function connectMcpServer(transport: any): Promise<{ close: () => Promise<void> }> {
  const McpServer = loadMcpServer();
  const server = new McpServer({ name: 'test-server', version: '0.0.1' });
  await server.connect(transport);
  return { close: () => server.close() };
}

describe('mcp-sdk transport multi-client init 行为实证', () => {
  const cleanupQueue: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanupQueue.length) {
      const fn = cleanupQueue.pop()!;
      try {
        await fn();
      } catch {
        /* swallow */
      }
    }
  });

  it('STATEFUL（sessionIdGenerator 非 undefined）+ 单 transport reuse → 第二次 init 撞 -32600 "Server already initialized"', async () => {
    const StreamableHTTPServerTransport = loadStreamableHttpTransport();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    const mcp = await connectMcpServer(transport);
    const server = await startServer(() => transport);
    cleanupQueue.push(async () => server.shutdown());
    cleanupQueue.push(async () => mcp.close());

    // client A initialize（成功）
    const r1 = await postInit(server.url, 1);
    expect(r1.bodyText).not.toMatch(/Server already initialized/);
    expect(r1.bodyJson?.error?.code).not.toBe(-32600);

    // client B initialize 同 transport reuse → 第二次 init 撞 -32600
    const r2 = await postInit(server.url, 2);
    const containsError =
      /Server already initialized|-32600/.test(r2.bodyText) ||
      r2.bodyJson?.error?.code === -32600;
    expect(containsError).toBe(true);
  });

  it('STATELESS（sessionIdGenerator: undefined）+ 单 transport reuse → 第二次 status=500 空 body（fix c67ddde 引入新 bug 实证 — multi-client init 仍 broken）', async () => {
    const StreamableHTTPServerTransport = loadStreamableHttpTransport();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const mcp = await connectMcpServer(transport);
    const server = await startServer(() => transport);
    cleanupQueue.push(async () => server.shutdown());
    cleanupQueue.push(async () => mcp.close());

    // 第一次 stateless mode init 成功(200 SSE)
    const r1 = await postInit(server.url, 1);
    expect(r1.status).toBe(200);
    expect(r1.bodyText).toMatch(/protocolVersion/);

    // mcp-sdk webStandardStreamableHttp.js:142-144 throw "Stateless transport cannot be reused across requests"。
    // hono getRequestListener (listener.js:518) 用 `handleFetchError` 把 fetchCallback throw 转成
    // `new Response(null, { status: 500 })` — status=500 + 空 body + console.error 不触发(因为
    // 走的是 res.catch(handleFetchError) 路径,不进 listener.js:443 handleResponseError)。
    //
    // 这是 fix c67ddde 引入的新 broken 表现 — 与 stateful mode -32600 错码不同,但同样 broken
    // (cross-adapter teammate 第二次 init 失败,send_message dispatch 仍不工作)。
    const r2 = await postInit(server.url, 2);
    expect(r2.status).toBe(500); // stateless reuse 失败特征 — broken
    expect(r2.bodyText).toBe(''); // 空 body 配合 status=500 = handleFetchError 兜底产物
  });

  it('STATELESS + 每 request 用 fresh transport instance → 两次 init 都成功（fix 路径 B 可行实证）', async () => {
    const StreamableHTTPServerTransport = loadStreamableHttpTransport();

    // server A — fresh transport
    const transportA = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcpA = await connectMcpServer(transportA);
    const serverA = await startServer(() => transportA);
    cleanupQueue.push(async () => serverA.shutdown());
    cleanupQueue.push(async () => mcpA.close());
    const r1 = await postInit(serverA.url, 1);
    expect(r1.status).toBe(200);
    expect(r1.bodyText).toMatch(/protocolVersion/);

    // server B — fresh transport instance(模拟 production 改 per-request fresh transport 行为)
    const transportB = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcpB = await connectMcpServer(transportB);
    const serverB = await startServer(() => transportB);
    cleanupQueue.push(async () => serverB.shutdown());
    cleanupQueue.push(async () => mcpB.close());
    const r2 = await postInit(serverB.url, 2);
    expect(r2.status).toBe(200);
    expect(r2.bodyText).toMatch(/protocolVersion/);
  });
});
