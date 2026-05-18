# Spike 1 Report: mcp-sdk McpServer.registerTool handler `extra` arg

**Date**: 2026-05-18
**Status**: ✅ Complete
**Drives**: HIGH-A (P2 caller_session_id transport 注入实施路径)

## 问题

mcp-sdk 1.29.0 `McpServer.registerTool` 注册的 handler 第二参数 `extra` 是否含 transport-level request context（如 Authorization header / per-request id / 已校验的 token info），让应用层能 per-request 注入 caller_session_id？若是 → 修法 (B) 直接走；若否 → 修法 (A) AsyncLocalStorage。

## 验证手段

1. 读 `node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0_zod@4.3.6/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts` 看 `ToolCallback` / `registerTool` 签名
2. 读 `dist/esm/shared/protocol.d.ts` 看 `RequestHandlerExtra` 类型字段
3. 读 `dist/esm/types.d.ts:7953` 看 `RequestInfo` 接口
4. 读 `dist/esm/server/streamableHttp.js:128-140` 看 transport.handleRequest 怎么从 `req.auth` 拿 authInfo 注入

## 结论

✅ **mcp-sdk 1.29.0 已暴露完整 transport-level request context；修法 (B) extra arg 直接可行**。

### `RequestHandlerExtra` 字段（protocol.d.ts:173-201）

```ts
export type RequestHandlerExtra<SendRequestT extends Request, SendNotificationT extends Notification> = {
  signal: AbortSignal;
  authInfo?: AuthInfo;        // ← validated access token info（关键!）
  sessionId?: string;          // ← transport 协议层 session id（与 agent-deck sessionId 无关）
  _meta?: RequestMeta;
  requestId: RequestId;
  taskId?: string;
  taskStore?: RequestTaskStore;
  taskRequestedTtl?: number;
  requestInfo?: RequestInfo;   // ← 原始 HTTP request（含 headers + url）
  sendNotification: ...;
  sendRequest: ...;
};
```

### `RequestInfo` 字段（types.d.ts:7953）

```ts
export interface RequestInfo {
  headers: IsomorphicHeaders;  // ← 含 Authorization 等所有 header
  url?: URL;
}
```

### `StreamableHTTPServerTransport.handleRequest` 注入路径（streamableHttp.js:128-140）

```js
async handleRequest(req, res, parsedBody) {
  const authInfo = req.auth;   // ← 从 req.auth 拿（fastify / express 中间件标准写法）
  const handler = getRequestListener(async (webRequest) => {
    return this._webStandardTransport.handleRequest(webRequest, {
      authInfo,                // ← 自动传到 handler extra.authInfo
      parsedBody
    });
  });
}
```

## agent-deck 应用现状 GAP

`src/main/agent-deck-mcp/tools/index.ts:73-92`：

```ts
export interface BuildAgentDeckToolsDeps {
  callerSessionIdOverride: (() => string | null) | null;  // ← 无参数 lazy provider
  transport: CallerContext['transport'];
}

function makeCtx(args: { ... }): HandlerContext {
  const overridden = callerSessionIdOverride?.() ?? null;  // ← 没接 extra
  ...
}

async (args) => spawnSessionHandler(args, makeCtx(args))  // ← handler 签名没接 extra
```

应用现有代码**没接收 mcp-sdk 传过来的 extra**，需要改造。

## 推荐修法路径

### Step A: 改 BuildAgentDeckToolsDeps 与 handler 签名

```ts
export interface BuildAgentDeckToolsDeps {
  callerSessionIdOverride: ((extra?: RequestHandlerExtra) => string | null) | null;
  transport: CallerContext['transport'];
}

async (args, extra) => spawnSessionHandler(args, makeCtx(args, extra))
```

### Step B: HookServer.onRequest 注入 req.auth

`src/main/hook-server/server.ts`：onRequest 在校验 `/mcp` token 通过后，调 `request.raw.auth = { resolvedSid: sessionTokenMap.get(token) ?? null, fallbackToGlobal: token === globalToken }`（命名待定）。

### Step C: transport-http.ts callerSessionIdOverride 实现

```ts
const adapted = await buildAgentDeckTools({
  callerSessionIdOverride: (extra) => {
    const auth = extra?.authInfo as any;
    return auth?.resolvedSid ?? null;
  },
  transport: 'http',
});
```

### Step D: 各 transport 行为对照

| Transport | extra.authInfo | callerSessionIdOverride 行为 |
|---|---|---|
| **in-process** | undefined（应用层不走 HTTP） | closure 直接 override（现状不变） |
| **HTTP** | `{resolvedSid}` from HookServer.onRequest | 走 extra.authInfo |
| **stdio** | undefined（stdio 无 HTTP auth） | undefined → fallback 走 args.caller_session_id |

## 影响范围

- **新增**: `mcp-session-token-map.ts`（per-session token → sid 映射）
- **改**: `src/main/agent-deck-mcp/tools/index.ts` (~15 行：BuildAgentDeckToolsDeps signature + makeCtx + handler 签名传 extra)
- **改**: `src/main/hook-server/server.ts` (~10 行：onRequest mcp 分支调 sessionTokenMap.get + 注入 req.raw.auth)
- **改**: `src/main/agent-deck-mcp/transport-http.ts` (~5 行：callerSessionIdOverride 实现)
- 现有 in-process / stdio transport 行为零变化

## 不需要 AsyncLocalStorage（修法 A 否决）

- AsyncLocalStorage 需 Node async hooks 显式包 onRequest async chain
- 修法 (B) 复用 mcp-sdk 原生 channel（req.auth → extra.authInfo），更简洁、与生态一致、debug 容易

## 残留风险

- ❓ mcp-sdk 内部把 req.auth 透传到 extra.authInfo 是 fastify / express 标准约定。**fastify 5 `request.raw` 是原 Node IncomingMessage**，需在 onRequest 写 `request.raw.auth = ...` 而不是 `request.auth = ...`（fastify 不直接暴露这个字段）。本 spike 未实跑 fastify 5 端到端验证，但 mcp-sdk 既然支持 express middleware 模式，fastify 也应当兼容（需 P2 实施时实测一次）
- 升级 mcp-sdk 版本时 `RequestHandlerExtra.authInfo` 字段稳定性需要 watch（当前 1.29.0 已 stable，但更早版本可能没这个字段）

## 后续 Spike 不再相关

Spike 1 结果决定 HIGH-A 修法走 (B) 路径。Spike 2 / 3 与本 spike 无依赖，独立进行。
