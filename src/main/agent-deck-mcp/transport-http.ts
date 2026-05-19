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
 * 与 **stateless**（sessionIdGenerator=undefined）两种模式。本应用走 **stateless 模式**，
 * 理由（plan reviewer-codex-cross-adapter-20260519 Phase 0 fix）：
 *
 * - 我们的 5 个 mcp tool（spawn / send / list / get / shutdown）**无 cross-request session state
 *   需求** — 每条 request 携带 caller_session_id（per-session token 反查 → resolvedSid），
 *   handler 只看单 request 内 args 即可处理，不需要 mcp-sdk 协议层 session lifecycle
 * - **stateful 模式撞「multi-client 共用单 transport instance」缺陷**：单 transport 维护一个
 *   session id；多 codex SDK 子进程（每个独立 mcp client）共用同一 transport 时，第二个
 *   client `initialize` 会撞 `Server already initialized` (-32600) 错误，全数 send_message
 *   等写工具 cross-adapter dispatch 失败。spike 1+2 实测铁证。
 * - **stateless 模式**：每 request 独立，不返 mcp-session-id header，不做 session validation；
 *   multi-client 直接 work（mcp-sdk 1.29 streamableHttp.js:44-46 注释明示语义）
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
 * 创建 mcp-sdk McpServer 实例并注册 5 个 agent-deck tool。
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
  // 无 HTTP auth，handler fallback args.caller_session_id）。
  //
  // **B-HIGH-1 (C) 修法 (c)（plan deep-review-batch-a1-b-fixes-20260519 / REVIEW_46）**:
  // 旧版 `?? null` 让 fallbackToGlobal=true（global token 路径无 per-session authn）的 caller
  // 能填 args.caller_session_id 当任意 active sid spoof 写工具（B-HIGH-1 反驳轮 mini-test 实证）。
  // 修法: fallbackToGlobal=true 时 force sentinel；per-session authn 通过时 resolvedSid = real sid
  // 走合法路径；任何其他情况兜底 sentinel（不让 args.caller_session_id 字段 escape 到 spoof 路径）。
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
 * 注册 POST/GET/DELETE /mcp 三个 fastify 路由，所有请求转发到同一个 StreamableHTTPServerTransport。
 *
 * **注意**：fastify 5 默认会解析 JSON body，所以 POST /mcp 的 `req.body` 已经是对象，
 * 透传给 transport.handleRequest 第三参数 `parsedBody`（详 mcp-sdk 文档示例）。
 */
export async function registerAgentDeckMcpHttpRoutes(
  routeRegistry: RouteRegistry,
): Promise<{ shutdown: () => Promise<void> }> {
  const { http } = await loadMcpSdk();
  // plan reviewer-codex-cross-adapter-20260519 Phase 0 fix：stateless 模式
  // (sessionIdGenerator=undefined)。multi-client 共用同一 transport instance 不撞
  // 「Invalid Request: Server already initialized」(spike 1+2 实测 root cause)。详 file
  // header 注释解释 stateful vs stateless 选择理由。
  const transport = new http.StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const mcpServer = await buildAgentDeckMcpServerForExternalTransport('http');
  // McpServer.connect 接受 SDK 自定义 Transport 接口；StreamableHTTPServerTransport 已实现该接口
  await (mcpServer as unknown as { connect: (t: unknown) => Promise<void> }).connect(transport);

  // 注册三个 fastify route。adapter id 用 'agent-deck-mcp' 占位，未来如果要按 adapter 启停
  // 路由可以按这个 id 反查 listForAdapter。
  for (const method of ['POST', 'GET', 'DELETE'] as const) {
    routeRegistry.registerForAdapter('agent-deck-mcp', {
      method,
      url: '/mcp',
      handler: async (req, reply) => {
        await transport.handleRequest(
          req.raw,
          reply.raw,
          method === 'POST' ? (req.body as unknown) : undefined,
        );
        // transport.handleRequest 已经直接写 reply.raw，告诉 fastify 别接管
        reply.hijack();
      },
    });
  }

  return {
    shutdown: async () => {
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
    },
  };
}
