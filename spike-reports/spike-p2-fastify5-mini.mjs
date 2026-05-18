#!/usr/bin/env node
/**
 * Spike P2 Step 2.2 mini-runner: fastify 5 onRequest hook 注入 request.raw.auth
 * 是否能透传到 mcp-sdk McpServer.registerTool handler 拿到 extra.authInfo？
 *
 * 验证设计：
 * 1. 起 fastify 5.8.5 HTTP server (port 0 自动选)
 * 2. addHook('onRequest') 在 /mcp 分支写 `request.raw.auth = {resolvedSid, fallbackToGlobal: false}`
 * 3. 注册 mcp-sdk 1.29.0 McpServer + StreamableHTTPServerTransport
 * 4. 注册 whoami dummy tool: handler 内回声 extra.authInfo
 * 5. 启 server → 用 mcp-sdk 的 Client + StreamableHTTPClientTransport 连 server
 * 6. Client 调 whoami → 拿到 extra.authInfo 与注入值一致 → 验证通过
 *
 * Run: cd <worktree> && node spike-reports/spike-p2-fastify5-mini.mjs
 */

import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// mcp-sdk 1.29.0 是通过 @anthropic-ai/claude-agent-sdk transitive 进来的(pnpm 严格模式不
// hoist 到顶层 node_modules)。直接 import '@modelcontextprotocol/sdk/...' 报 ERR_MODULE_NOT_FOUND。
// 走 .pnpm 内部子目录的绝对路径(应用层 transport-http.ts 用 dynamicImport 走同一路径,见
// transport-http.ts:29-31 注释)。
const MCP_SDK_ROOT =
  '/Users/apple/Repository/personal/agent-deck/node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0_zod@4.3.6/node_modules/@modelcontextprotocol/sdk/dist/esm';
const { McpServer } = await import(`${MCP_SDK_ROOT}/server/mcp.js`);
const { StreamableHTTPServerTransport } = await import(`${MCP_SDK_ROOT}/server/streamableHttp.js`);
const { Client } = await import(`${MCP_SDK_ROOT}/client/index.js`);
const { StreamableHTTPClientTransport } = await import(`${MCP_SDK_ROOT}/client/streamableHttp.js`);

const INJECTED_SID = 'mocked-sid-from-token-map';
const INJECTED_TOKEN = 'mocked-bearer-token-abc123';

let serverObservedAuthInfo = null;

const fastify = Fastify({ logger: false });

fastify.addHook('onRequest', async (request) => {
  if (request.url.startsWith('/mcp')) {
    const auth = request.headers['authorization'];
    if (typeof auth === 'string' && auth === `Bearer ${INJECTED_TOKEN}`) {
      // ⬇️ 关键注入点：写到 request.raw.auth(IncomingMessage),mcp-sdk handleRequest 内
      // `const authInfo = req.auth` 直接取(transport-http.ts 把 req.raw 传给 handleRequest)
      request.raw.auth = { resolvedSid: INJECTED_SID, fallbackToGlobal: false };
    }
  }
});

const mcpServer = new McpServer({ name: 'spike-server', version: '0.0.1' });

mcpServer.registerTool(
  'whoami',
  {
    description: 'echo extra.authInfo for verification',
    inputSchema: { dummy: z.string().optional() },
  },
  async (_args, extra) => {
    serverObservedAuthInfo = extra?.authInfo ?? null;
    return {
      content: [{ type: 'text', text: JSON.stringify({ authInfo: extra?.authInfo ?? null }) }],
    };
  },
);

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
});
await mcpServer.connect(transport);

for (const method of ['POST', 'GET', 'DELETE']) {
  fastify.route({
    method,
    url: '/mcp',
    handler: async (req, reply) => {
      await transport.handleRequest(
        req.raw,
        reply.raw,
        method === 'POST' ? req.body : undefined,
      );
      reply.hijack();
    },
  });
}

await fastify.listen({ port: 0, host: '127.0.0.1' });
const addr = fastify.server.address();
const port = typeof addr === 'object' && addr ? addr.port : null;
if (!port) throw new Error('fastify port not allocated');
console.log(`[spike] fastify listening on 127.0.0.1:${port}`);

const client = new Client({ name: 'spike-client', version: '0.0.1' });
const clientTransport = new StreamableHTTPClientTransport(
  new URL(`http://127.0.0.1:${port}/mcp`),
  { requestInit: { headers: { Authorization: `Bearer ${INJECTED_TOKEN}` } } },
);

const failures = [];

try {
  await client.connect(clientTransport);
  console.log('[spike] mcp client connected');

  const result = await client.callTool({ name: 'whoami', arguments: {} });
  const text = result?.content?.[0]?.text ?? '';
  const parsed = JSON.parse(text);
  console.log('[spike] whoami returned:', JSON.stringify(parsed));
  console.log('[spike] server-side observed extra.authInfo:', JSON.stringify(serverObservedAuthInfo));

  if (!parsed.authInfo) {
    failures.push('client-visible authInfo is null/undefined — fastify request.raw.auth NOT propagated to mcp-sdk extra.authInfo');
  } else if (parsed.authInfo.resolvedSid !== INJECTED_SID) {
    failures.push(
      `client-visible authInfo.resolvedSid mismatch: got=${parsed.authInfo.resolvedSid}, expected=${INJECTED_SID}`,
    );
  } else if (parsed.authInfo.fallbackToGlobal !== false) {
    failures.push(
      `client-visible authInfo.fallbackToGlobal mismatch: got=${parsed.authInfo.fallbackToGlobal}, expected=false`,
    );
  } else {
    console.log('[spike] ✅ client-visible authInfo matches injected value');
  }

  if (!serverObservedAuthInfo || serverObservedAuthInfo.resolvedSid !== INJECTED_SID) {
    failures.push(
      `server-side extra.authInfo not captured / mismatch: ${JSON.stringify(serverObservedAuthInfo)}`,
    );
  } else {
    console.log('[spike] ✅ server-side handler observed authInfo correctly');
  }
} catch (err) {
  failures.push(`exception during client.callTool: ${err.message}`);
} finally {
  try {
    await client.close();
  } catch {
    /* ignore */
  }
  await fastify.close();
}

if (failures.length > 0) {
  console.error('\n[spike] ❌ FAILED:');
  for (const f of failures) console.error('  -', f);
  process.exit(1);
}

console.log('\n[spike] ✅ ALL CHECKS PASSED — fastify 5 request.raw.auth → mcp-sdk extra.authInfo 通路验证 OK');
process.exit(0);
