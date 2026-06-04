/**
 * Agent Deck MCP server HTTP transport（B'0 ADR §2 / §5 / B'4）。
 *
 * 把 mcp-sdk `McpServer` 通过 `StreamableHTTPServerTransport` 挂到 HookServer
 * fastify 的 `/mcp` 路由上。三个 HTTP 方法（POST / GET / DELETE）共用同一个 handler
 * （MCP Streamable HTTP spec 定义），由 transport 内部分流。
 *
 * 鉴权：B'5 在 HookServer.onRequest 加 `/mcp` 前缀分支 + 独立 mcpServerToken（与
 * hookServerToken 隔离）。本文件不重复鉴权 —— 路由级 hook 已在请求进入 handler 前
 * 拦截非法请求。
 *
 * 生命周期：MCP server 在 enableAgentDeckMcp + mcpHttpEnabled 双开关 ON 时由
 * main bootstrap 调 `registerAgentDeckMcpHttpRoutes` 挂载；OFF 时不挂（HookServer
 * 路由表不会出现 /mcp，新请求会被 fastify 默认 404 处理）。toggle 后状态需重启
 * HookServer 才能换 / 撤路由（fastify 不支持运行时 deregister 路由）—— 后续 B'6
 * UI 可加「重启 MCP HTTP transport」按钮，或 settings.mcpHttpEnabled 改了之后
 * 显示「需要重启应用生效」提示。
 *
 * mcp-sdk 1.29.0 `StreamableHTTPServerTransport` 支持 **stateful**（自管 sessionIdGenerator）
 * 与 **stateless**（sessionIdGenerator=undefined）两种模式。本应用走 **stateless 模式 +
 * per-request fresh transport instance**（plan reviewer-codex-cross-adapter-20260519
 * Phase 0 收口结论 + Step 0.4 fix 路径 B 实证）：
 *
 * - 我们的 18 个 mcp tool（10 会话/plan/worktree + 5 task + 3 issue；详 tools/index.ts SSOT）
 *   都**无 cross-request session state 需求** — 每条 request 携带 callerSessionId（per-session
 *   token 反查 → resolvedSid），handler 只看单 request 内 args 即可处理，不需要 mcp-sdk
 *   协议层 session lifecycle
 * - **stateful 模式撞「multi-client 共用单 transport instance」缺陷**：单 transport 维护一个
 *   session id；多 codex SDK 子进程（每个独立 mcp client）共用同一 transport 时，第二个
 *   client `initialize` 撞 `Server already initialized` (-32600) 错误。spike 1+2 实测铁证
 * - **stateless 模式 + 单 transport reuse 仍 broken**：mcp-sdk webStandardStreamableHttp.js:142-144
 *   throw `Stateless transport cannot be reused across requests` — hono `handleFetchError`
 *   把 throw 转 status=500 空 body。multi-client 第二次 init 仍失败,只是错码换成 500。
 *   transport-http-multi-client-init.test.ts 实证（fix c67ddde 不充分）
 * - **修法 = stateless + per-request fresh transport**（mcp-sdk official example
 *   `simpleStatelessStreamableHttp.js` 标准 pattern）：每 request 创建 fresh transport +
 *   fresh McpServer + connect → handleRequest，request 完成后 close 两者。每 request 独立
 *   transport instance，不撞 reuse / already-initialized 错。test 实证两次 init 都 200。
 *
 * 鉴权：B'5 在 HookServer.onRequest 加 `/mcp` 前缀分支 + 独立 mcpServerToken（与
 * hookServerToken 隔离）。本文件不重复鉴权 —— 路由级 hook 已在请求进入 handler 前
 * 拦截非法请求。两层正交：mcp-sdk transport stateless（无协议层 session）+
 * HookServer auth check（per-session bearer token → resolvedSid 注入）。
 */

import type { RouteRegistry } from '@main/hook-server/route-registry';
import { buildAgentDeckTools } from './tools';
import { EXTERNAL_CALLER_SENTINEL, type McpAuthInfo } from './types';

const dynamicImport = new Function('s', 'return import(s)') as <T = unknown>(
  s: string,
) => Promise<T>;

interface McpSdkServerModule {
  McpServer: new (info: { name: string; version: string }) => {
    registerTool: (
      name: string,
      config: Record<string, unknown>,
      cb: (args: any, extra?: unknown) => Promise<any>,
    ) => unknown;
    connect: (transport: unknown) => Promise<void>;
    close: () => Promise<void>;
  };
}

interface McpStreamableHttpModule {
  StreamableHTTPServerTransport: new (options: {
    sessionIdGenerator: (() => string) | undefined;
  }) => {
    handleRequest: (req: unknown, res: unknown, body?: unknown) => Promise<void>;
    close: () => Promise<void>;
  };
}

let cachedMcpSdk: { server: McpSdkServerModule; http: McpStreamableHttpModule } | null = null;

/**
 * @internal Only for `__tests__/`. Do NOT import from other production files.
 *
 * 抽自 `registerAgentDeckMcpHttpRoutes` 内部 `callerSessionIdOverride` lambda（plan
 * deep-review-batch-a1-b-followup-r3-20260519 §Phase 1.1a / D6 export production lambda）。
 * 让 spoofing-attack-paths.test.ts / transport-http-extra-auth.test.ts 调真实 lambda
 * 而非 inline 复制合约（H4 教训：inline 合约漂移 bug）。
 *
 * 行为契约（B-HIGH-1 (C) 修法 (c)）：
 * - `authInfo.fallbackToGlobal === true` → return EXTERNAL_CALLER_SENTINEL（防 spoofing）
 * - `authInfo.resolvedSid` 非空 → return 该 sid（per-session authn 通过路径）
 * - 缺 authInfo / resolvedSid 兜底 → return EXTERNAL_CALLER_SENTINEL
 *
 * 外部 production 文件**严禁** import 此 lambda 用作业务逻辑 — 业务路径仍走
 * `registerAgentDeckMcpHttpRoutes` 内部传入 `buildAgentDeckTools` 的 closure。
 */
export function resolveCallerSidForReadOnly(extra?: unknown): string {
  const authInfo = (extra as { authInfo?: McpAuthInfo } | undefined)?.authInfo;
  if (authInfo?.fallbackToGlobal) {
    // global token 路径 — 无 per-session authn → force sentinel 防 spoofing
    return EXTERNAL_CALLER_SENTINEL;
  }
  // per-session authn 通过 → resolvedSid = real sid（合法）；
  // 缺 authInfo / resolvedSid 兜底 sentinel（不让 args fallback path 触发）。
  return authInfo?.resolvedSid ?? EXTERNAL_CALLER_SENTINEL;
}

async function loadMcpSdk(): Promise<{
  server: McpSdkServerModule;
  http: McpStreamableHttpModule;
}> {
  if (!cachedMcpSdk) {
    const [server, http] = await Promise.all([
      dynamicImport<McpSdkServerModule>('@modelcontextprotocol/sdk/server/mcp.js'),
      dynamicImport<McpStreamableHttpModule>(
        '@modelcontextprotocol/sdk/server/streamableHttp.js',
      ),
    ]);
    cachedMcpSdk = { server, http };
  }
  return cachedMcpSdk;
}

/**
 * 创建 mcp-sdk McpServer 实例并注册 18 个 agent-deck tool。
 * 调用方负责把它 connect 到 transport（HTTP / stdio）。
 */
async function buildAgentDeckMcpServerForExternalTransport(transportName: 'http' | 'stdio') {
  const { server } = await loadMcpSdk();
  const mcpServer = new server.McpServer({
    name: 'agent-deck',
    version: '0.1.0',
  });
  // SdkMcpToolDefinition 内部已含 zod schema + handler；mcp-sdk McpServer.registerTool
  // 接受 inputSchema = ZodRawShape。两个 tool() 工厂的字段名兼容（name / description /
  // inputSchema / handler），但 SdkMcpToolDefinition 把字段塞在不同 key 下，需要一次浅适配。
  //
  // **plan codex-handoff-team-alignment-20260518 P2 Step 2.4 修法**：HTTP transport 的
  // callerSessionIdOverride 从 mcp-sdk RequestHandlerExtra.authInfo 读取 resolvedSid
  // （HookServer.checkMcpAuth 已经写到 IncomingMessage.auth → mcp-sdk handleRequest 读
  // req.auth → 注入到 tool handler extra.authInfo）。stdio transport 维持 null（stdio
  // 无 HTTP auth，handler fallback args.callerSessionId）。
  //
  // **B-HIGH-1 (C) 修法 (c)（plan deep-review-batch-a1-b-fixes-20260519 / REVIEW_46）**:
  // 旧版 `?? null` 让 fallbackToGlobal=true（global token 路径无 per-session authn）的 caller
  // 能填 args.callerSessionId 当任意 active sid spoof 写工具（B-HIGH-1 反驳轮 mini-test 实证）。
  // 修法: fallbackToGlobal=true 时 force sentinel；per-session authn 通过时 resolvedSid = real sid
  // 走合法路径；任何其他情况兜底 sentinel（不让 args.callerSessionId 字段 escape 到 spoof 路径）。
  //
  // **plan deep-review-batch-a1-b-followup-r3-20260519 §Phase 1.1a 修订**：lambda body 抽到
  // module-level `resolveCallerSidForReadOnly` export 让 __tests__/ 调真实代码（D6 修法）。
  //
  // **plan §Phase 6.3 L3 注释精确化（不删 ternary）**：旧版三元
  // `transportName === 'http' ? resolveCallerSidForReadOnly : null` 在 buildAgentDeckMcpServerForExternalTransport
  // 唯一 caller（line 171）只传 'http' 的现状下永真，但保留 ternary 防未来扩展 stdio external
  // transport（注：stdio 当前走 transport-stdio.ts 自己的 buildAgentDeckTools 调用,不进本 fn）。
  // 同步 BuildAgentDeckToolsDeps.callerSessionIdOverride 类型仍是 `(...) | null` 兼容 test seam,
  // 不收窄类型避免大幅改 test。
  const callerSessionIdOverride = transportName === 'http' ? resolveCallerSidForReadOnly : null;
  const adapted = await buildAgentDeckTools({
    callerSessionIdOverride,
    transport: transportName,
  });
  for (const t of adapted) {
    // claude-agent-sdk 的 SdkMcpToolDefinition 字段（参考 sdk.d.ts）：
    //   { name: string, description?: string, inputSchema: ZodRawShape, handler, annotations? }
    // mcp-sdk McpServer.registerTool 接 (name, { description, inputSchema, ... }, cb)
    const def = t as unknown as {
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
      handler: (args: any, extra: unknown) => Promise<any>;
      annotations?: Record<string, unknown>;
    };
    mcpServer.registerTool(
      def.name,
      {
        description: def.description ?? '',
        inputSchema: def.inputSchema,
        annotations: def.annotations,
      },
      def.handler,
    );
  }
  return mcpServer;
}

/**
 * HTTP transport：由 main bootstrap 在 enableAgentDeckMcp+mcpHttpEnabled 双开 ON 时调用。
 * 注册 POST/GET/DELETE /mcp 三个 fastify 路由。
 *
 * **per-request fresh transport + fresh server**（plan reviewer-codex-cross-adapter-20260519
 * Phase 0 Step 0.4 finding：fix c67ddde 的 stateless 单 transport reuse 仍 broken — mcp-sdk
 * webStandardStreamableHttp.js:142-144 throw `Stateless transport cannot be reused across requests`,
 * hono `handleFetchError` 把 throw 转 status=500 空 body。multi-client init 仍失败,只是错码换成 500）。
 *
 * 修法走 mcp-sdk 1.29 官方 example `simpleStatelessStreamableHttp.js` 标准 pattern:
 * - POST /mcp 每 request 创建 fresh `StreamableHTTPServerTransport` + 新 `McpServer` + connect
 *   → handleRequest → 完成后 close 两者。每个 request 独立 transport instance, no
 *   `Stateless transport cannot be reused` throw, no `Server already initialized` (-32600)
 * - GET /mcp / DELETE /mcp → 405 Method not allowed（stateless 不支持 SSE 长连 / session DELETE）
 *
 * 性能开销:每 request 跑 `buildAgentDeckMcpServerForExternalTransport`（new McpServer + 5
 * tool register）+ McpServer.connect(transport)。loadSdk module cache 命中（V8 dedupe）,
 * 整体毫秒级,production load 可接受。test: transport-http-multi-client-init.test.ts 实证
 * fix 路径 B 两次 init 都 200。
 *
 * **注意**：fastify 5 默认会解析 JSON body，所以 POST /mcp 的 `req.body` 已经是对象，
 * 透传给 transport.handleRequest 第三参数 `parsedBody`（详 mcp-sdk 文档示例）。
 */
export async function registerAgentDeckMcpHttpRoutes(
  routeRegistry: RouteRegistry,
): Promise<{ shutdown: () => Promise<void> }> {
  const { http } = await loadMcpSdk();

  // POST /mcp — per-request fresh transport + fresh server + connect → handleRequest
  routeRegistry.registerForAdapter('agent-deck-mcp', {
    method: 'POST',
    url: '/mcp',
    handler: async (req, reply) => {
      const transport = new http.StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const mcpServer = await buildAgentDeckMcpServerForExternalTransport('http');
      // McpServer.connect 接受 SDK 自定义 Transport 接口；StreamableHTTPServerTransport 已实现该接口
      await (mcpServer as unknown as { connect: (t: unknown) => Promise<void> }).connect(
        transport,
      );

      // res.on('close') 注册清理 — handleRequest 完成（含 SSE 流式发送结束）后清 transport / server
      // mcp-sdk official example simpleStatelessStreamableHttp.js 同款套路（不用 try/finally
      // 因为 SSE response 是流式 close 后才能 close transport）
      reply.raw.on('close', () => {
        // 兜底 close — 触发 mcp-sdk transport / server 内部 cleanup（释放任何 in-memory 资源）
        // close 失败 swallow（避免 process unhandled rejection）
        Promise.resolve()
          .then(async () => {
            try {
              await transport.close();
            } catch {
              /* ignore */
            }
            try {
              await (mcpServer as unknown as { close: () => Promise<void> }).close();
            } catch {
              /* ignore */
            }
          })
          .catch(() => {
            /* swallow */
          });
      });

      try {
        await transport.handleRequest(req.raw, reply.raw, req.body as unknown);
      } catch (e) {
        // mcp-sdk handleRequest 内部 throw 一般被 hono getRequestListener `handleFetchError`
        // 转成 status=500 空 body（不会到这里）。极端情况兜底 — request 还没写过 header 就抛
        // 错,我们补 500 + JSON-RPC error 让 client 能解析（mcp-sdk official example 同款套路）。
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
                  (e instanceof Error ? e.message : String(e)),
              },
              id: null,
            }),
          );
        } else if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
      // transport.handleRequest 已经直接写 reply.raw，告诉 fastify 别接管
      reply.hijack();
    },
  });

  // GET / DELETE — stateless 模式不支持（mcp-sdk official example 同款 405 套路）
  for (const method of ['GET', 'DELETE'] as const) {
    routeRegistry.registerForAdapter('agent-deck-mcp', {
      method,
      url: '/mcp',
      handler: async (_req, reply) => {
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
    shutdown: async () => {
      // per-request transport / server lifecycle 在 reply.raw close 事件里清理 — shutdown 时
      // 没有「全局持久 transport」需要 close。fastify route 由 routeRegistry / HookServer 自行
      // deregister（HookServer 重启时一并清）。本 shutdown 是 noop 兼容 caller bootstrap 接口。
    },
  };
}
